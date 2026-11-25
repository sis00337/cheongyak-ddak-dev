"""공식 청약홈 API -> 정적 앱 데이터. Python 3.11+, 외부 패키지 불필요."""
import argparse
import json
import os
import sys
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, unquote, urlparse
from urllib.request import Request, urlopen
try:
    from scripts.eligibility_rules import apply_reviews, load_rules, pdf_digest
except ImportError:
    from eligibility_rules import apply_reviews, load_rules, pdf_digest

ROOT = Path(__file__).resolve().parents[1]
KST = timezone(timedelta(hours=9))
BASE = 'https://api.odcloud.kr/api/ApplyhomeInfoDetailSvc/v1/'
SOURCE = 'https://www.data.go.kr/data/15098547/openapi.do'
ENDPOINTS = {
    'apt': 'getAPTLttotPblanc',
    'remndr': 'getRemndrLttotPblanc',
    'other': 'getUrbtyOfctlLttotPblanc',
    'rent': 'getPblPvtRentLttotPblanc',
    'optional': 'getOPTLttotPblanc',
}
REGIONS = {
    '서울특별시': '서울', '부산광역시': '부산', '대구광역시': '대구',
    '인천광역시': '인천', '광주광역시': '광주', '대전광역시': '대전',
    '울산광역시': '울산', '세종특별자치시': '세종', '경기도': '경기',
    '강원특별자치도': '강원', '강원도': '강원', '충청북도': '충북',
    '충청남도': '충남', '전북특별자치도': '전북', '전라북도': '전북',
    '전라남도': '전남', '경상북도': '경북', '경상남도': '경남',
    '제주특별자치도': '제주',
}


class SyncError(Exception):
    pass


def iso(value):
    if value is None or str(value).strip() in ('', '-', 'null'):
        return None
    digits = ''.join(c for c in str(value) if c.isdigit())
    if len(digits) != 8:
        raise SyncError('공고 날짜 형식 오류')
    try:
        return date(int(digits[:4]), int(digits[4:6]), int(digits[6:])).isoformat()
    except ValueError:
        raise SyncError('유효하지 않은 공고 날짜') from None


def number(value):
    if value is None or str(value).strip() in ('', '-'):
        return None
    try:
        result = int(str(value).replace(',', '').strip())
    except ValueError:
        raise SyncError('공급금액 또는 세대수 형식 오류') from None
    if result < 0:
        raise SyncError('음수 공급금액 또는 세대수')
    return result


def identity(row):
    values = [str(row.get(k) or '').strip() for k in ('HOUSE_MANAGE_NO', 'PBLANC_NO')]
    if not all(v.isdigit() for v in values):
        raise SyncError('공고 식별번호 누락')
    return tuple(values)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def read_json(path, default):
    return json.loads(Path(path).read_text(encoding='utf-8')) if Path(path).exists() else default


class Client:
    def __init__(self, key):
        self.key = unquote(key.strip())

    def request(self, endpoint, params):
        query = urlencode(dict(params, serviceKey=self.key, returnType='JSON'))
        # 인증키가 포함된 URL, 응답 본문, 원본 예외는 로그에 출력하지 않는다.
        for attempt in range(3):
            try:
                req = Request(BASE + endpoint + '?' + query, headers={'Accept': 'application/json'})
                with urlopen(req, timeout=40) as response:
                    payload = json.load(response)
                if not isinstance(payload, dict) or not isinstance(payload.get('data'), list):
                    raise SyncError('API 응답 오류: 인증 권한과 서비스 상태를 확인하세요')
                return payload
            except HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504):
                    raise SyncError(f'API HTTP {exc.code}: 인증키와 활용 승인을 확인하세요') from None
            except (URLError, TimeoutError):
                pass
            except (ValueError, UnicodeError):
                raise SyncError('API JSON 응답 오류') from None
            if attempt < 2:
                time.sleep(2 ** attempt)
        raise SyncError('API 연결 실패: 재시도 횟수 초과')

    def pages(self, endpoint, conditions=None):
        rows, seen, expected = [], set(), None
        for page in range(1, 1001):
            payload = self.request(endpoint, dict(conditions or {}, page=page, perPage=100))
            batch = payload['data']
            total = payload.get('matchCount', payload.get('totalCount'))
            if not isinstance(total, int) or total < 0 or isinstance(total, bool):
                raise SyncError('API 전체 건수 누락')
            if expected is None:
                expected = total
            elif total != expected:
                raise SyncError('수집 도중 공고 건수가 변경됨: 다음 실행에서 재시도')
            for row in batch:
                if not isinstance(row, dict):
                    raise SyncError('API 행 형식 오류')
                key = identity(row) + (str(row.get('MODEL_NO') or ''),)
                if key in seen:
                    raise SyncError('중복 페이지 또는 공고 식별자 감지')
                seen.add(key)
                rows.append(row)
            if len(rows) == expected:
                return rows
            if not batch or len(rows) > expected:
                raise SyncError('API 페이지 일부 누락')
        raise SyncError('API 페이지 한도 초과')

    def pdf_digest(self, url):
        return pdf_digest(url, urlopen)


def normalize(row, category, models):
    manage, notice = identity(row)
    name = str(row.get('HOUSE_NM') or '').strip()
    if not name:
        raise SyncError('주택명 누락')
    address = str(row.get('HSSPLY_ADRES') or '')
    region_raw = str(row.get('SUBSCRPT_AREA_CODE_NM') or address.split(' ')[0])
    region = REGIONS.get(region_raw, region_raw if region_raw in REGIONS.values() else '확인 필요')
    start = iso(row.get('RCEPT_BGNDE') or row.get('SUBSCRPT_RCEPT_BGNDE'))
    end = iso(row.get('RCEPT_ENDDE') or row.get('SUBSCRPT_RCEPT_ENDDE'))
    if start and end and start > end:
        raise SyncError('접수 시작일이 종료일보다 늦음')
    types = []
    for model in models:
        if identity(model) != (manage, notice):
            raise SyncError('다른 공고의 주택형 응답 감지')
        types.append({'label': str(model.get('HOUSE_TY') or model.get('TP') or model.get('MODEL_NO')),
                      'price': number(model.get('LTTOT_TOP_AMOUNT') or model.get('SUPLY_AMOUNT'))})
    prices = [m['price'] for m in types if m['price'] is not None and m['price'] > 0]
    supplied = row.get('PBLANC_URL') or ''
    parsed = urlparse(supplied)
    detail = supplied if parsed.scheme == 'https' and parsed.hostname in ('www.applyhome.co.kr', 'applyhome.co.kr') else ''
    if not detail:
        detail = 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancListView.do'
    supply = {'apt': 'APT', 'remndr': '무순위·잔여세대', 'rent': '공공지원민간임대',
              'optional': '임의공급', 'other': row.get('HOUSE_DTL_SECD_NM') or '오피스텔·기타'}[category]
    if category == 'remndr' and str(row.get('HOUSE_SECD')) == '06':
        supply = '불법행위재공급'
    return {
        'id': 'ah' + notice, 'houseManageNo': manage, 'pblancNo': notice,
        'category': category, 'houseSecd': row.get('HOUSE_SECD'), 'name': name,
        'region': region, 'regionGroup': region, 'district': address, 'address': address,
        'supplyType': supply, 'housingRequirement': '확인 필요', 'requiredDeposit': None,
        'depositNote': '예치금·납입 요건은 공급 유형과 주택형에 따라 공고문 확인 필요',
        'residenceRequirement': '확인 필요', 'eligibleRegions': [], 'priorityRegions': [],
        'householderOnly': None, 'verified': False, 'eligibilityStatus': 'needs_review',
        'evidence': {}, 'extraRequirements': ['신청 자격은 공고문에서 별도 확인해야 합니다'],
        'priceLabel': '공급금액(주택형별 최고금액)',
        'priceMin': min(prices) if prices else None, 'priceMax': max(prices) if prices else None,
        'priceRange': (' ~ '.join(f'{p:,}만 원' for p in sorted(set((min(prices), max(prices)))))) if prices else '가격 미확인',
        'units': number(row.get('TOT_SUPLY_HSHLDCO')), 'types': types,
        'applyStart': start, 'applyEnd': end, 'applyDates': f'{start or "미정"} ~ {end or "미정"}',
        'announceDate': iso(row.get('RCRIT_PBLANC_DE')),
        'winnersDate': iso(row.get('PRZWNER_PRESNATN_DE')),
        'contractStart': iso(row.get('CNTRCT_CNCLS_BGNDE')),
        'moveIn': row.get('MVN_PREARNGE_YM'), 'builder': row.get('CNSTRCT_ENTRPS_NM') or row.get('BSNS_MBY_NM'),
        'tel': row.get('MDHS_TELNO'), 'detailUrl': detail, 'applyUrl': '',
        'source': '한국부동산원 청약홈 분양정보 조회 서비스', 'sourceUrl': SOURCE,
        'sourceEndpoint': ENDPOINTS[category] + 'Detail',
    }


def collect(client, today):
    listings, seen, scanned = [], {}, {}
    for category, prefix in ENDPOINTS.items():
        rows = client.pages(prefix + 'Detail')  # 공고일 제한 없이 과거 장기접수 공고도 확인
        scanned[category] = len(rows)
        for row in rows:
            key = identity(row)
            end = iso(row.get('RCEPT_ENDDE') or row.get('SUBSCRPT_RCEPT_ENDDE'))
            if end and end < today:
                continue
            # 서로 다른 공식 목록에 중복 노출될 수 있다. 값이 다르면 조용히 덮어쓰지 않는다.
            if key in seen:
                shared = set(row) & set(seen[key])
                if any(row[k] != seen[key][k] for k in shared):
                    raise SyncError('목록 사이 중복 공고 내용 불일치')
                continue
            seen[key] = row
            models = client.pages(prefix + 'Mdl', {
                'cond[HOUSE_MANAGE_NO::EQ]': key[0], 'cond[PBLANC_NO::EQ]': key[1]})
            listings.append(normalize(row, category, models))
    if sum(scanned.values()) == 0:
        raise SyncError('모든 공식 목록이 비어 있어 기존 데이터를 유지합니다')
    if len({x['id'] for x in listings}) != len(listings):
        raise SyncError('앱 공고 ID 충돌')
    listings.sort(key=lambda x: (x['applyEnd'] or '9999', x['id']))
    return listings, scanned


def run(client, output, status_path, now=None, rules_path=None):
    now = now or datetime.now(KST)
    stamp = now.isoformat(timespec='seconds')
    previous = read_json(status_path, {})
    try:
        listings, scanned = collect(client, now.date().isoformat())
        rules = load_rules(rules_path or ROOT / 'data/eligibility-rules.json')
        counts = apply_reviews(listings, rules, client.pdf_digest if hasattr(client, 'pdf_digest') else lambda url: None, now)
        document = {'meta': {
            'source': '한국부동산원 청약홈 분양정보 조회 서비스', 'sourceUrl': SOURCE,
            'collectedAt': now.date().isoformat(), 'updatedAt': stamp, 'count': len(listings),
            'scope': '전국 · APT / 무순위·잔여세대 / 오피스텔·기타 / 공공지원민간임대 / 임의공급',
            'unit': '금액 단위: 만 원', 'scannedCounts': scanned, 'eligibilityCounts': counts,
            'unverified': [x['id'] for x in listings if not x['verified']]}, 'listings': listings}
        atomic_json(output, document)
    except Exception as exc:
        # 알 수 없는 예외도 키나 응답 본문이 노출되지 않도록 타입만 기록한다.
        message = str(exc) if isinstance(exc, SyncError) else '수집 처리 오류 (' + type(exc).__name__ + ')'
        atomic_json(status_path, {'status': 'error', 'attemptedAt': stamp,
                                 'lastSuccessAt': previous.get('lastSuccessAt'), 'message': message})
        raise SyncError(message) from None
    atomic_json(status_path, {'status': 'ok', 'attemptedAt': stamp, 'lastSuccessAt': stamp,
                             'count': len(listings), 'message': '공식 공고 갱신 완료'})
    return len(listings)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'data/listings.json')
    parser.add_argument('--status', type=Path, default=ROOT / 'data/sync-status.json')
    args = parser.parse_args()
    key = os.environ.get('APPLYHOME_SERVICE_KEY', '').strip()
    try:
        if not key:
            class MissingKeyClient:
                def pages(self, *args, **kwargs):
                    raise SyncError('APPLYHOME_SERVICE_KEY가 없습니다. GitHub Actions Secret을 등록하세요')
            client = MissingKeyClient()
        else:
            client = Client(key)
        count = run(client, args.output, args.status)
        print(f'공식 공고 {count}건 갱신 완료')
        return 0
    except SyncError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
