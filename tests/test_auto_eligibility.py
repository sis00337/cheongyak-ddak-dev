import hashlib
import json
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock

from scripts import auto_eligibility as auto

NOW = datetime(2026, 11, 26, 18, tzinfo=timezone(timedelta(hours=9)))
URL = ('https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?houseManageNo=2026000560'
       '&pblancNo=2026000560&atchmnflSeqNo=2022113&atchmnflSn=4')
PAGES = [
    '해링턴 플레이스 입주자모집공고\n공급 개요',
    '■ 신청자격\n입주자모집공고일 현재 서울특별시에 거주하는\n만19세 이상 무주택세대구성원 중 세대주',
    '■ 청약통장\n청약예금 지역별·면적별 예치금액 이상 예치한 분\n재당첨 제한 기간 10년',
]
PDF = b'%PDF-1.7 fake'
DIGEST = hashlib.sha256(PDF).hexdigest()


def listing():
    return {'id': 'ah2026000560', 'houseManageNo': '2026000560', 'pblancNo': '2026000560',
            'name': '해링턴 플레이스', 'supplyType': 'APT', 'region': '서울', 'announceDate': '2026-11-14',
            'applyEnd': '2026-11-28', 'detailUrl': 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?x=1',
            'verified': False, 'eligibility': {'state': 'needs_review'}}


def raw(quote_housing='무주택세대구성원 중 세대주', page=2):
    return {
        'checks': {
            'housing': {'kind': 'none', 'page': page, 'quote': quote_housing},
            'residence': {'kind': 'regions', 'values': ['서울'], 'page': 2, 'quote': '입주자모집공고일 현재 서울특별시에 거주하는'},
            'deposit': {'kind': 'standard_table', 'amountWon': 0, 'page': 3, 'quote': '지역별·면적별 예치금액 이상 예치한 분'},
            'householder': {'kind': 'required', 'page': 2, 'quote': '무주택세대구성원 중 세대주'},
        },
        'manualChecks': [{'label': '재당첨 제한', 'note': '재당첨 제한 기간 10년을 확인하세요.', 'page': 3}],
        'summary': '서울 거주 무주택 세대주만 1순위 신청 가능합니다.',
    }


class Fetcher:
    def __init__(self):
        self.html_calls = 0

    def html(self, url):
        self.html_calls += 1
        return '<a href="' + URL.replace('&', '&amp;') + '" class="radius_btn">모집공고문 보기</a>'

    def pdf(self, url):
        assert url == URL
        return PDF


class FakeClient:
    def __init__(self, payload, stop='end_turn'):
        self.calls = 0
        self.payload, self.stop = payload, stop
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        self.calls += 1
        assert kwargs['model'] == auto.MODEL
        assert kwargs['output_config']['format']['type'] == 'json_schema'
        assert '[p.2]' in kwargs['messages'][0]['content']
        return SimpleNamespace(stop_reason=self.stop, content=[SimpleNamespace(type='text', text=json.dumps(self.payload))])


def run(client, cache=None, items=None):
    items = items or [listing()]
    with mock.patch.object(auto, 'extract_pages', return_value=PAGES * 1):
        new_cache, counts = auto.run(items, cache or {}, Fetcher(), client, NOW, log=lambda m: None)
    return items, new_cache, counts


class AutoEligibilityTests(unittest.TestCase):
    def setUp(self):
        # 추출 텍스트가 짧으면 스캔본으로 보고 건너뛰므로 테스트용으로 길이를 채운다.
        PAGES[0] = PAGES[0] + ' 안내' * 300

    def test_pdf_link_must_belong_to_the_same_notice(self):
        html = '<a href="' + URL.replace('2026000560', '2026000999') + '">x</a>'
        self.assertIsNone(auto.find_pdf_url(html, '2026000560', '2026000560'))
        self.assertEqual(auto.find_pdf_url(Fetcher().html(''), '2026000560', '2026000560'), URL)

    def test_verified_quotes_become_auto_review(self):
        items, cache, counts = run(FakeClient(raw()))
        item = items[0]
        self.assertEqual(counts['auto'], 1)
        self.assertEqual(item['eligibility']['state'], 'auto')
        self.assertEqual(item['eligibilityStatus'], 'auto_review')
        self.assertTrue(item['verified'])
        self.assertEqual(set(item['eligibility']['checks']), {'housing', 'residence', 'deposit', 'householder'})
        self.assertEqual(item['eligibleRegions'], ['서울'])
        self.assertTrue(item['householderOnly'])
        self.assertIn('지역·면적별', item['depositNote'])
        self.assertEqual(cache['entries']['2026000560-2026000560']['sha256'], DIGEST)

    def test_invented_quote_is_dropped_and_wrong_page_corrected(self):
        payload = raw(quote_housing='무주택자라면 누구나 신청 가능', page=2)
        payload['checks']['residence']['page'] = 1
        items, _, _ = run(FakeClient(payload))
        checks = items[0]['eligibility']['checks']
        self.assertNotIn('housing', checks)
        self.assertEqual(checks['residence']['page'], 2)

    def test_cached_analysis_is_reused_without_calling_claude(self):
        _, cache, _ = run(FakeClient(raw()))
        client = FakeClient(raw())
        items, cache2, counts = run(client, cache)
        self.assertEqual(client.calls, 0)
        self.assertEqual(counts['auto'], 1)
        self.assertEqual(cache2, cache)

    def test_changed_pdf_without_api_key_drops_auto_review(self):
        _, cache, _ = run(FakeClient(raw()))
        cache['entries']['2026000560-2026000560']['sha256'] = 'f' * 64
        items, _, counts = run(None, cache)
        self.assertEqual(counts['auto'], 0)
        self.assertFalse(items[0]['verified'])

    def test_refusal_or_truncation_leaves_listing_unreviewed(self):
        items, cache, counts = run(FakeClient(raw(), stop='refusal'))
        self.assertFalse(items[0]['verified'])
        self.assertEqual(cache['entries'], {})

    def test_human_review_wins(self):
        item = listing()
        item['eligibility'] = {'state': 'reviewed'}
        client = FakeClient(raw())
        items, _, _ = run(client, items=[item])
        self.assertEqual(client.calls, 0)
        self.assertEqual(items[0]['eligibility']['state'], 'reviewed')

    def test_new_analyses_per_run_are_capped(self):
        many = []
        for n in range(3):
            item = listing()
            many.append(item)
        client = FakeClient(raw())
        with mock.patch.object(auto, 'extract_pages', return_value=PAGES):
            auto.run(many, {}, Fetcher(), client, NOW, max_new=1, log=lambda m: None)
        self.assertEqual(client.calls, 1)

    def test_page_selection_keeps_overview_and_eligibility_pages(self):
        pages = ['개요'] * 3 + ['무관한 내용 ' * 2000] * 5 + ['신청자격 무주택 세대주 거주']
        chosen = auto.select_pages(pages, limit=5000)
        self.assertEqual(chosen[:3], [0, 1, 2])
        self.assertIn(8, chosen)

    def test_subscription_cli_runs_without_tools_and_api_key(self):
        seen = {}

        def runner(cmd, **kwargs):
            seen['cmd'], seen['env'], seen['input'] = cmd, kwargs['env'], kwargs['input']
            out = {'type': 'result', 'is_error': False, 'result': '', 'structured_output': raw()}
            return SimpleNamespace(returncode=0, stdout=json.dumps(out))

        with mock.patch.dict('os.environ', {'ANTHROPIC_API_KEY': '', 'CLAUDE_CODE_OAUTH_TOKEN': 't'}):
            items, _, counts = run(auto.CliClient('claude', runner))
        cmd = seen['cmd']
        self.assertEqual(cmd[cmd.index('--tools') + 1], '')
        self.assertIn('--json-schema', cmd)
        self.assertNotIn('ANTHROPIC_API_KEY', seen['env'])
        self.assertIn('[p.2]', seen['input'])
        self.assertEqual(counts['auto'], 1)
        self.assertEqual(items[0]['eligibility']['state'], 'auto')

    def test_subscription_cli_failure_or_missing_output_is_skipped(self):
        for out, code in [({'is_error': True}, 0), ({'result': 'no schema'}, 0), ({}, 1)]:
            runner = lambda cmd, **k: SimpleNamespace(returncode=code, stdout=json.dumps(out))
            items, _, counts = run(auto.CliClient('claude', runner))
            self.assertEqual(counts['auto'], 0)
            self.assertFalse(items[0]['verified'])


if __name__ == '__main__':
    unittest.main()
