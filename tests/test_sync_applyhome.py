import importlib.util
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('sync', Path(__file__).resolve().parents[1] / 'scripts/sync_applyhome.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def row(**changes):
    value = {'HOUSE_MANAGE_NO': '2026000001', 'PBLANC_NO': '2026000002',
             'HOUSE_NM': '테스트 공고', 'SUBSCRPT_AREA_CODE_NM': '서울',
             'RCRIT_PBLANC_DE': '20261101', 'RCEPT_BGNDE': '2026-11-26',
             'RCEPT_ENDDE': '2026-11-27', 'TOT_SUPLY_HSHLDCO': '20',
             'PRZWNER_PRESNATN_DE': '20261201'}
    return dict(value, **changes)


class FakeClient:
    def pages(self, endpoint, conditions=None):
        if endpoint == sync.ENDPOINTS['apt'] + 'Detail':
            return [row()]
        if endpoint.endswith('Mdl'):
            return [dict(row(), MODEL_NO='01', HOUSE_TY='084A', LTTOT_TOP_AMOUNT='80,000')]
        return []


class CollectorTests(unittest.TestCase):
    def test_date_formats_and_invalid_dates(self):
        self.assertEqual(sync.iso('20261125'), '2026-11-25')
        self.assertEqual(sync.iso('2026-11-25'), '2026-11-25')
        with self.assertRaises(sync.SyncError):
            sync.iso('2026-02-30')

    def test_normalization_does_not_invent_eligibility(self):
        data = sync.normalize(row(PBLANC_URL='javascript:alert(1)'), 'apt', [])
        self.assertFalse(data['verified'])
        self.assertIsNone(data['requiredDeposit'])
        self.assertEqual(data['eligibleRegions'], [])
        self.assertEqual(data['applyUrl'], '')
        self.assertTrue(data['detailUrl'].startswith('https://www.applyhome.co.kr/'))
        self.assertIsNone(data['priceMin'])

    def test_model_price_is_highest_price_not_minimum_unit_price(self):
        model = dict(row(), MODEL_NO='01', HOUSE_TY='84A', LTTOT_TOP_AMOUNT='80,000')
        data = sync.normalize(row(), 'apt', [model])
        self.assertEqual(data['priceMin'], 80000)
        self.assertIn('최고금액', data['priceLabel'])

    def test_cross_notice_model_is_rejected(self):
        with self.assertRaises(sync.SyncError):
            sync.normalize(row(), 'apt', [row(PBLANC_NO='999')])

    def test_pages_use_match_count_and_fetch_all(self):
        client = sync.Client('not-a-real-key')
        with patch.object(client, 'request', side_effect=[
            {'data': [row()], 'matchCount': 2, 'totalCount': 100},
            {'data': [row(PBLANC_NO='3')], 'matchCount': 2, 'totalCount': 100},
        ]) as request:
            self.assertEqual(len(client.pages('test')), 2)
            self.assertEqual(request.call_args.args[1]['page'], 2)

    def test_missing_or_repeated_page_rejected(self):
        for second in ([], [row()]):
            client = sync.Client('not-a-real-key')
            with patch.object(client, 'request', side_effect=[
                {'data': [row()], 'matchCount': 2}, {'data': second, 'matchCount': 2}
            ]):
                with self.assertRaises(sync.SyncError):
                    client.pages('test')

    def test_success_and_failure_preserve_last_good_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            output, status = Path(folder) / 'listings.json', Path(folder) / 'status.json'
            now = datetime(2026, 11, 25, 9, 37, tzinfo=sync.KST)
            self.assertEqual(sync.run(FakeClient(), output, status, now), 1)
            snapshot = output.read_bytes()
            success = json.loads(status.read_text(encoding='utf-8'))['lastSuccessAt']
            with patch.object(FakeClient, 'pages', side_effect=sync.SyncError('API HTTP 403')):
                with self.assertRaises(sync.SyncError):
                    sync.run(FakeClient(), output, status, now)
            self.assertEqual(output.read_bytes(), snapshot)
            report = json.loads(status.read_text(encoding='utf-8'))
            self.assertEqual(report['status'], 'error')
            self.assertEqual(report['lastSuccessAt'], success)

    def test_partial_failure_never_publishes_partial_list(self):
        with tempfile.TemporaryDirectory() as folder:
            output, status = Path(folder) / 'listings.json', Path(folder) / 'status.json'
            output.write_text('{"old": true}')
            client = FakeClient()
            original = client.pages
            def fail_later(endpoint, conditions=None):
                if endpoint == sync.ENDPOINTS['optional'] + 'Detail':
                    raise sync.SyncError('일부 목록 실패')
                return original(endpoint, conditions)
            client.pages = fail_later
            with self.assertRaises(sync.SyncError):
                sync.run(client, output, status)
            self.assertEqual(output.read_text(), '{"old": true}')

    def test_closed_removed_unknown_schedule_kept(self):
        client = FakeClient()
        def pages(endpoint, conditions=None):
            if endpoint.endswith('Mdl'):
                return []
            if endpoint == sync.ENDPOINTS['apt'] + 'Detail':
                return [row(RCEPT_ENDDE='2026-11-24'), row(PBLANC_NO='3', RCEPT_ENDDE=None)]
            return []
        client.pages = pages
        listings, _ = sync.collect(client, '2026-11-25')
        self.assertEqual([x['pblancNo'] for x in listings], ['3'])

    def test_all_empty_aborts(self):
        client = FakeClient()
        client.pages = lambda *args: []
        with self.assertRaises(sync.SyncError):
            sync.collect(client, '2026-11-25')

    def test_unexpected_exception_does_not_leak_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            status = Path(folder) / 'status.json'
            client = FakeClient()
            client.pages = lambda *args: (_ for _ in ()).throw(ValueError('serviceKey=SECRET'))
            with self.assertRaises(sync.SyncError):
                sync.run(client, Path(folder) / 'listings.json', status)
            self.assertNotIn('SECRET', status.read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
