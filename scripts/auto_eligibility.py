"""공고문 PDF를 Claude로 자동 분석해 조건별 자격 근거를 붙인다.

수집(sync_applyhome.py)이 끝난 data/listings.json을 읽어 사람이 검토하지 않은 공고에만 적용한다.
- 공고문 PDF는 청약홈 상세 페이지의 '모집공고문 보기' 링크에서 찾는다.
- 같은 PDF(SHA-256)는 한 번만 분석하고 data/auto-eligibility.json에 저장해 재사용한다.
- Claude가 돌려준 근거 문장은 PDF에서 추출한 해당 쪽 텍스트에 실제로 있어야만 쓴다.
  원문에서 찾지 못한 조건은 버리고 '확인 필요'로 남긴다.
- ANTHROPIC_API_KEY가 없으면 새 분석은 하지 않고, 저장된 분석 중 PDF가 그대로인 것만 다시 붙인다.
- 공고 하나의 실패가 다른 공고나 공고 데이터 갱신을 막지 않는다.
"""
import hashlib
import io
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

try:
    from scripts.eligibility_rules import REGIONS, attach_review, pdf_bytes, validate_rule
except ImportError:
    from eligibility_rules import REGIONS, attach_review, pdf_bytes, validate_rule

ROOT = Path(__file__).resolve().parents[1]
KST = timezone(timedelta(hours=9))
MODEL = 'claude-opus-5-5'
PROMPT_VERSION = 1
MAX_CHARS = 90000
MAX_NEW_PER_RUN = 15
REGION_LIST = ['서울', '경기', '인천', '부산', '울산', '경남', '대구', '경북', '대전', '세종',
               '충북', '충남', '광주', '전북', '전남', '강원', '제주']
KEYWORDS = ('신청자격', '청약자격', '신청 자격', '공급대상', '신청대상', '무주택', '세대주', '세대원',
            '거주', '예치', '청약통장', '1순위', '2순위', '해당지역', '기타지역', '주택소유', '유주택')
PDF_LINK = re.compile(r'https://static\.applyhome\.co\.kr/ai/aia/getAtchmnfl\.do\?[^"\'<>\s]+')

SYSTEM = """당신은 한국 아파트·오피스텔 청약 입주자모집공고문을 읽고 신청 자격을 구조화하는 분석가입니다.
결과는 청약 준비자가 공고문을 직접 읽지 않고도 자기 조건과 비교하는 데 쓰입니다.
틀린 '부합' 판정은 사용자에게 실제 피해를 주므로, 공고문 문장으로 확실히 뒷받침되는 조건만 채우고
나머지는 kind를 "unknown"으로 두세요. 추측하지 마세요.

판정 기준:
- 순위가 있는 일반공급(APT)은 '일반공급 1순위' 신청 자격을 기준으로 합니다. 특별공급은 제외합니다.
- 무순위·잔여세대·임의공급·오피스텔·민간임대는 그 공고의 신청 자격 하나를 기준으로 합니다.
- housing: 무주택세대구성원만 가능하면 "none", 1주택까지 가능하면 "max_one", 주택 소유와 무관하면 "not_required".
- residence: 신청할 수 있는 거주 시도 전체를 values에 넣고 kind는 "regions". 국내 거주자 누구나 가능하면 17개 시도를 모두 넣습니다.
  우선공급 지역만이 아니라 신청이 허용되는 지역(해당지역 + 기타지역) 전체입니다.
- deposit: 청약통장이 필요 없으면 "not_required". 금액 하나가 모두에게 적용되면 "minimum"과 amountWon(원 단위).
  민영주택처럼 '거주지역별·전용면적별 예치금액' 기준을 적용하면 "standard_table". 그 외(국민주택 납입횟수 등)는 "unknown".
  amountWon은 "minimum"일 때만 의미가 있고, 그 밖에는 0을 넣으세요.
- householder: 세대주만 신청 가능하면 "required", 세대원도 가능하면 "not_required".
- quote: 판단 근거가 된 공고문 문장을 한 글자도 바꾸지 말고 그대로 짧게(15~80자) 옮기세요. 요약하거나 고치면 검증에서 탈락합니다.
- page: quote가 있는 쪽 번호. 텍스트의 [p.N] 표시를 따릅니다.
- kind가 "unknown"이면 page는 0, quote는 빈 문자열로 둡니다.
- manualChecks: 위 네 조건 외에 신청 전에 꼭 확인해야 할 제한(재당첨 제한, 소득·자산 기준, 거주기간, 나이, 해외 체류, 중복 청약 제한 등)을
  공고문에 있는 것만 1~5개, 각각 한 문장으로. page는 근거가 있는 쪽.
- summary: 이 공고의 신청 자격을 사용자에게 한두 문장으로 설명. 확정할 수 없는 부분은 그렇다고 쓰세요."""


def _check_schema(kinds, with_values=False, with_amount=False):
    props = {'kind': {'type': 'string', 'enum': kinds}, 'page': {'type': 'integer'}, 'quote': {'type': 'string'}}
    if with_values:
        props['values'] = {'type': 'array', 'items': {'type': 'string', 'enum': REGION_LIST}}
    if with_amount:
        props['amountWon'] = {'type': 'integer'}
    return {'type': 'object', 'properties': props, 'required': list(props), 'additionalProperties': False}


SCHEMA = {
    'type': 'object',
    'properties': {
        'checks': {
            'type': 'object',
            'properties': {
                'housing': _check_schema(['none', 'max_one', 'not_required', 'unknown']),
                'residence': _check_schema(['regions', 'unknown'], with_values=True),
                'deposit': _check_schema(['minimum', 'not_required', 'standard_table', 'unknown'], with_amount=True),
                'householder': _check_schema(['required', 'not_required', 'unknown']),
            },
            'required': ['housing', 'residence', 'deposit', 'householder'],
            'additionalProperties': False,
        },
        'manualChecks': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {'label': {'type': 'string'}, 'note': {'type': 'string'}, 'page': {'type': 'integer'}},
                'required': ['label', 'note', 'page'], 'additionalProperties': False,
            },
        },
        'summary': {'type': 'string'},
    },
    'required': ['checks', 'manualChecks', 'summary'],
    'additionalProperties': False,
}


def normalize_text(text):
    """줄바꿈·공백·가운뎃점·괄호 차이를 무시하고 비교한다."""
    return re.sub(r'[\s·ㆍ·‧\-–—()\[\]「」『』"\'“”‘’.,:;※]', '', text or '')


def find_pdf_url(detail_html, house_no, pblanc_no):
    for match in PDF_LINK.finditer(detail_html or ''):
        url = match.group(0).replace('&amp;', '&')
        query = parse_qs(urlparse(url).query)
        if query.get('houseManageNo') == [house_no] and query.get('pblancNo') == [pblanc_no]:
            return url
    return None


def extract_pages(body):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(body))
    return [(page.extract_text() or '') for page in reader.pages]


def select_pages(pages, limit=MAX_CHARS):
    """자격 관련 쪽을 우선해 원래 순서대로 고른다. 앞 3쪽(개요)은 항상 넣는다."""
    total = sum(len(p) for p in pages)
    if total <= limit:
        return list(range(len(pages)))
    scored = sorted(range(len(pages)), key=lambda i: (-sum(pages[i].count(k) for k in KEYWORDS), i))
    chosen, size = set(range(min(3, len(pages)))), sum(len(pages[i]) for i in range(min(3, len(pages))))
    for i in scored:
        if i in chosen:
            continue
        if size + len(pages[i]) > limit:
            continue
        chosen.add(i)
        size += len(pages[i])
    return sorted(chosen)


def build_document(listing, pages):
    head = (f"공고명: {listing.get('name')}\n공급유형: {listing.get('supplyType')}\n지역: {listing.get('region')}\n"
            f"공고일: {listing.get('announceDate')}\n\n아래는 공고문 PDF에서 추출한 텍스트입니다 (자격 관련 쪽 위주).\n")
    body = '\n\n'.join(f'[p.{i + 1}]\n{pages[i]}' for i in select_pages(pages))
    return head + body


def ask_claude(client, listing, pages):
    """Claude에게 구조화된 분석을 요청한다. 거절·잘림이면 None."""
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        output_config={'effort': 'medium', 'format': {'type': 'json_schema', 'schema': SCHEMA}},
        betas=['server-side-fallback-2026-07-01'],
        fallbacks='default',
        messages=[{'role': 'user', 'content': build_document(listing, pages)}],
    )
    if response.stop_reason != 'end_turn':
        return None
    text = next((b.text for b in response.content if b.type == 'text'), '')
    return json.loads(text)


def verify(raw, pages):
    """근거 문장이 원문에 있는 조건만 남긴다. 쪽 번호가 틀리면 실제로 나온 쪽으로 고친다."""
    normalized = [normalize_text(p) for p in pages]

    def locate(quote, page):
        q = normalize_text(quote)
        if len(q) < 6:
            return None
        if 1 <= page <= len(pages) and q in normalized[page - 1]:
            return page
        for i, text in enumerate(normalized):
            if q in text:
                return i + 1
        return None

    checks = {}
    for key, check in (raw.get('checks') or {}).items():
        if not isinstance(check, dict) or check.get('kind') in (None, 'unknown'):
            continue
        page = locate(check.get('quote', ''), check.get('page', 0))
        if not page:
            continue
        entry = {'kind': check['kind'], 'page': page, 'quote': check['quote'].strip()}
        if key == 'residence':
            values = [v for v in check.get('values') or [] if v in REGIONS]
            if not values:
                continue
            entry['values'] = sorted(set(values), key=REGION_LIST.index)
        if check['kind'] == 'minimum':
            amount = check.get('amountWon')
            if type(amount) is not int or amount <= 0:
                continue
            entry['amountWon'] = amount
        checks[key] = entry
    manual = []
    for item in raw.get('manualChecks') or []:
        if item.get('label') and item.get('note') and type(item.get('page')) is int and 1 <= item['page'] <= len(pages):
            manual.append({'label': item['label'].strip()[:40], 'note': item['note'].strip()[:200], 'page': item['page']})
    if not manual:
        manual = [{'label': '추가 자격', 'note': '나이·소득·자산·재당첨 제한 등은 공고문에서 확인하세요.', 'page': 1}]
    return checks, manual[:5]


def build_rule(listing, url, digest, checks, manual, today):
    until = today + timedelta(days=31)
    if listing.get('applyEnd'):
        try:
            until = min(until, max(today, date.fromisoformat(listing['applyEnd'])))
        except ValueError:
            pass
    rule = {
        'houseManageNo': listing['houseManageNo'], 'pblancNo': listing['pblancNo'],
        'announceDate': listing.get('announceDate') or today.isoformat(),
        'reviewedAt': today.isoformat(), 'validUntil': until.isoformat(),
        'source': {'url': url, 'sha256': digest}, 'checks': checks, 'manualChecks': manual,
    }
    validate_rule(rule)
    return rule


class Fetcher:
    def html(self, url):
        parsed = urlparse(url)
        if parsed.scheme != 'https' or parsed.hostname not in ('www.applyhome.co.kr', 'applyhome.co.kr'):
            raise ValueError('허용하지 않는 상세 페이지 주소')
        req = Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; cheongyak-ddak)'})
        with urlopen(req, timeout=25) as response:
            return response.read(3 * 1024 * 1024).decode('utf-8', 'replace')

    def pdf(self, url):
        return pdf_bytes(url, urlopen)


def run(listings, cache, fetcher, client, now, max_new=MAX_NEW_PER_RUN, log=print):
    """listings를 제자리에서 갱신하고 (새 캐시, 집계)를 돌려준다."""
    today = now.date()
    entries = cache.get('entries', {}) if cache.get('schemaVersion') == 1 else {}
    fresh, counts, analyzed = {}, {'auto': 0, 'autoSkipped': 0}, 0
    for listing in listings:
        if listing.get('eligibility', {}).get('state') == 'reviewed':
            continue  # 사람이 검토한 근거가 우선한다.
        key = listing['houseManageNo'] + '-' + listing['pblancNo']
        try:
            cached = entries.get(key)
            url = cached['sourceUrl'] if cached else find_pdf_url(fetcher.html(listing['detailUrl']), listing['houseManageNo'], listing['pblancNo'])
            if not url:
                counts['autoSkipped'] += 1
                continue
            body = fetcher.pdf(url)
            digest = hashlib.sha256(body).hexdigest()
            usable = (cached and cached['sha256'] == digest and cached.get('promptVersion') == PROMPT_VERSION
                      and cached.get('announceDate') == listing.get('announceDate')
                      and date.fromisoformat(cached['analyzedAt'][:10]) >= today - timedelta(days=31))
            if not usable:
                if client is None or analyzed >= max_new:
                    counts['autoSkipped'] += 1
                    continue
                analyzed += 1
                pages = extract_pages(body)
                if sum(len(p) for p in pages) < 500:
                    log(f'{key}: 텍스트를 추출할 수 없는 공고문 (스캔본)')
                    counts['autoSkipped'] += 1
                    continue
                raw = ask_claude(client, listing, pages)
                if raw is None:
                    log(f'{key}: 분석 응답을 받지 못함')
                    counts['autoSkipped'] += 1
                    continue
                checks, manual = verify(raw, pages)
                cached = {'sourceUrl': url, 'sha256': digest, 'announceDate': listing.get('announceDate'),
                          'analyzedAt': now.isoformat(timespec='seconds'), 'model': MODEL,
                          'promptVersion': PROMPT_VERSION, 'checks': checks, 'manualChecks': manual,
                          'summary': str(raw.get('summary') or '')[:300]}
            fresh[key] = cached
            if not cached['checks']:
                counts['autoSkipped'] += 1
                continue
            rule = build_rule(listing, url, digest, cached['checks'], cached['manualChecks'],
                              date.fromisoformat(cached['analyzedAt'][:10]))
            attach_review(listing, rule, digest, now, state='auto',
                          extra={'analyzedAt': cached['analyzedAt'], 'summary': cached.get('summary', '')})
            counts['auto'] += 1
        except Exception as exc:  # 한 공고의 실패가 나머지를 막지 않는다.
            log(f'{key}: 자동 분석 건너뜀 ({type(exc).__name__})')
            counts['autoSkipped'] += 1
    return {'schemaVersion': 1, 'entries': fresh}, counts


def main():
    listings_path = ROOT / 'data/listings.json'
    cache_path = ROOT / 'data/auto-eligibility.json'
    document = json.loads(listings_path.read_text(encoding='utf-8'))
    cache = json.loads(cache_path.read_text(encoding='utf-8')) if cache_path.exists() else {}
    client = None
    if os.environ.get('ANTHROPIC_API_KEY', '').strip():
        import anthropic
        client = anthropic.Anthropic()
    else:
        print('ANTHROPIC_API_KEY가 없어 새 공고는 분석하지 않고 저장된 분석만 적용합니다.')
    now = datetime.now(KST)
    new_cache, counts = run(document['listings'], cache, Fetcher(), client, now)
    meta = document['meta']
    meta.setdefault('eligibilityCounts', {}).update(counts)
    meta['eligibilityCounts']['needsReview'] = sum(1 for x in document['listings'] if not x['verified'])
    meta['unverified'] = [x['id'] for x in document['listings'] if not x['verified']]
    for path, value in ((listings_path, document), (cache_path, new_cache)):
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        tmp.replace(path)
    print(f"자동 분석 적용 {counts['auto']}건, 보류 {counts['autoSkipped']}건")
    return 0


if __name__ == '__main__':
    sys.exit(main())
