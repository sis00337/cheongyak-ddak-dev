"""검토한 공고문과 동일한 원본일 때만 항목별 자격 근거를 연결한다."""
import copy
import hashlib
import json
import re
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlparse

REGIONS = {'서울', '경기', '인천', '부산', '울산', '경남', '대구', '경북', '대전', '세종', '충북', '충남', '광주', '전북', '전남', '강원', '제주'}
KINDS = {'housing': {'none', 'max_one', 'not_required'}, 'residence': {'regions'},
         'deposit': {'minimum', 'not_required', 'standard_table'}, 'householder': {'required', 'not_required'}}


def validate_rule(rule):
    if not all(str(rule.get(k, '')).isdigit() for k in ('houseManageNo', 'pblancNo')):
        raise ValueError('검토 공고 식별자 오류')
    source = rule['source']
    url = urlparse(source['url'])
    query = parse_qs(url.query)
    if (url.scheme != 'https' or url.hostname != 'static.applyhome.co.kr' or url.port or
            url.username or url.fragment or url.path != '/ai/aia/getAtchmnfl.do' or
            query.get('houseManageNo') != [rule['houseManageNo']] or query.get('pblancNo') != [rule['pblancNo']]):
        raise ValueError('검토 공고와 원문 URL 불일치')
    if not re.fullmatch(r'[a-f0-9]{64}', source['sha256']):
        raise ValueError('원문 해시 오류')
    date.fromisoformat(rule['announceDate'])
    reviewed = date.fromisoformat(rule['reviewedAt'])
    until = date.fromisoformat(rule['validUntil'])
    if not reviewed <= until <= reviewed + timedelta(days=31):
        raise ValueError('검토 유효기간 오류')
    if not isinstance(rule['checks'], dict) or not rule['checks']:
        raise ValueError('검토 항목 누락')
    for key, check in rule['checks'].items():
        if key not in KINDS or check.get('kind') not in KINDS[key]:
            raise ValueError('지원하지 않는 검토 조건')
        if type(check.get('page')) is not int or check['page'] < 1 or not check.get('quote', '').strip():
            raise ValueError('페이지·근거 누락')
        if key == 'residence' and (not check.get('values') or not set(check['values']) <= REGIONS):
            raise ValueError('거주 시도 오류')
        if check['kind'] == 'minimum' and (type(check.get('amountWon')) is not int or check['amountWon'] <= 0):
            raise ValueError('예치금 단위·금액 오류')
    if not isinstance(rule['manualChecks'], list) or not rule['manualChecks']:
        raise ValueError('추가 확인 사항 누락')
    for item in rule['manualChecks']:
        if not item.get('label') or not item.get('note') or type(item.get('page')) is not int or item['page'] < 1:
            raise ValueError('추가 확인 사항의 근거 누락')


def load_rules(path):
    document = json.loads(Path(path).read_text(encoding='utf-8'))
    if document.get('schemaVersion') != 1:
        raise ValueError('지원하지 않는 검토 형식')
    rules = {}
    for rule in document['reviews']:
        validate_rule(rule)
        key = (rule['houseManageNo'], rule['pblancNo'])
        if key in rules:
            raise ValueError('중복 검토 공고')
        rules[key] = rule
    return rules


def apply_reviews(listings, rules, fetch_digest, now):
    counts = {'reviewed': 0, 'needsReview': 0}
    today = now.date().isoformat()
    for listing in listings:
        reset_listing(listing)
        rule = rules.get((listing['houseManageNo'], listing['pblancNo']))
        reason = None
        if rule:
            if rule['announceDate'] != listing.get('announceDate'):
                reason = '공고일이 변경되어 자격 근거를 다시 확인해야 합니다.'
            elif not rule['reviewedAt'] <= today <= rule['validUntil']:
                reason = '자격 근거의 검토 유효기간이 지나 다시 확인해야 합니다.'
            else:
                try:
                    digest = fetch_digest(rule['source']['url'])
                    if digest != rule['source']['sha256']:
                        reason = '공고문 원본이 변경되어 자격 근거를 다시 확인해야 합니다.'
                except Exception:
                    reason = '현재 공고문 원본을 대조하지 못해 자격 판정을 보류합니다.'
            if not reason:
                attach_review(listing, rule, digest, now)
        if reason:
            listing['eligibility']['reason'] = reason
        counts['reviewed' if listing['verified'] else 'needsReview'] += 1
    return counts


def reset_listing(listing):
    """자격 관련 표시값을 '확인 필요' 상태로 되돌린다."""
    listing.update(housingRequirement='확인 필요', requiredDeposit=None,
                   depositNote='공고문에서 예치금·납입 요건 확인 필요',
                   residenceRequirement='확인 필요', eligibleRegions=[], priorityRegions=[],
                   householderOnly=None, evidence={}, extraRequirements=['신청 자격은 공고문에서 확인해야 합니다'])
    listing['verified'] = False
    listing['eligibilityStatus'] = 'needs_review'
    listing['eligibility'] = {'state': 'needs_review', 'reason': '공고문 항목별 검토 전입니다.'}


def attach_review(listing, rule, digest, now, state='reviewed', extra=None):
    """검증을 통과한 검토 결과(사람 검토 또는 자동 분석)를 공고에 붙인다."""
    listing['verified'] = True  # 원문 일치 여부. 최종 신청 가능 판정을 뜻하지 않는다.
    listing['eligibilityStatus'] = 'partial_review' if state == 'reviewed' else 'auto_review'
    listing['pdfUrl'] = rule['source']['url']
    listing['eligibility'] = dict({
        'state': state, 'checkedAt': now.isoformat(timespec='seconds'),
        'reviewedAt': rule['reviewedAt'], 'validUntil': rule['validUntil'],
        'sourceUrl': rule['source']['url'], 'sourceSha256': digest,
        'checks': copy.deepcopy(rule['checks']), 'manualChecks': copy.deepcopy(rule['manualChecks']),
    }, **(extra or {}))
    checks = rule['checks']
    housing = checks.get('housing', {}).get('kind')
    listing['housingRequirement'] = {'none': '무주택 전용', 'max_one': '1주택 가능', 'not_required': '무관'}.get(housing, '확인 필요')
    residence = checks.get('residence', {}).get('values', [])
    listing['eligibleRegions'] = list(residence)
    listing['residenceRequirement'] = '전국' if len(residence) == 17 else '·'.join(residence) or '확인 필요'
    deposit = checks.get('deposit', {})
    kind = deposit.get('kind')
    listing['requiredDeposit'] = 0 if kind == 'not_required' else (deposit['amountWon'] / 10000 if kind == 'minimum' else None)
    listing['depositNote'] = {
        'not_required': '공고문에서 청약통장 불필요 확인',
        'minimum': '공고문에서 확인한 기준. 추가 조건은 원문 확인',
        'standard_table': '지역·면적별 예치금 기준 적용 (거주지와 가장 작은 주택형으로 계산)',
    }.get(kind, '공고문에서 예치금·납입 요건 확인 필요')
    head = checks.get('householder', {}).get('kind')
    listing['householderOnly'] = True if head == 'required' else False if head == 'not_required' else None
    listing['extraRequirements'] = [item['label'] + ': ' + item['note'] for item in rule['manualChecks']]


def pdf_bytes(url, opener):
    with opener(url, timeout=25) as response:
        final = urlparse(response.geturl())
        if final.scheme != 'https' or final.hostname != 'static.applyhome.co.kr':
            raise ValueError('허용하지 않는 공고문 리디렉션')
        body = response.read(10 * 1024 * 1024 + 1)
    if not body.startswith(b'%PDF-') or len(body) > 10 * 1024 * 1024:
        raise ValueError('공고문 PDF 형식·크기 오류')
    return body


def pdf_digest(url, opener):
    return hashlib.sha256(pdf_bytes(url, opener)).hexdigest()
