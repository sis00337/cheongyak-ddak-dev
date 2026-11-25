import copy
import hashlib
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from scripts.eligibility_rules import apply_reviews, load_rules, validate_rule, pdf_digest

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 11, 25, 22, tzinfo=timezone(timedelta(hours=9)))


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.rules = load_rules(ROOT / 'data/eligibility-rules.json')
        self.rule = copy.deepcopy(next(iter(self.rules.values())))
        self.listing = {k: self.rule[k] for k in ('houseManageNo', 'pblancNo', 'announceDate')}
        self.listing['id'] = 'ah' + self.rule['pblancNo']

    def apply(self, digest=None, now=NOW):
        return apply_reviews([self.listing], self.rules, lambda url: digest or self.rule['source']['sha256'], now)

    def test_matching_notice_and_pdf_attach_only_explicit_checks(self):
        self.assertEqual(self.apply()['reviewed'], 1)
        self.assertTrue(self.listing['verified'])
        self.assertEqual(self.listing['housingRequirement'], '확인 필요')
        self.assertIsNone(self.listing['householderOnly'])
        self.assertEqual(self.listing['requiredDeposit'], 0)

    def test_modified_source_removes_prior_review_and_display_assertions(self):
        self.apply()
        self.assertEqual(self.apply('f' * 64)['reviewed'], 0)
        self.assertFalse(self.listing['verified'])
        self.assertIsNone(self.listing['requiredDeposit'])
        self.assertEqual(self.listing['eligibleRegions'], [])
        self.assertNotIn('checks', self.listing['eligibility'])

    def test_offline_original_downgrades_without_losing_listing(self):
        def offline(url):
            raise OSError('unavailable')
        counts = apply_reviews([self.listing], self.rules, offline, NOW)
        self.assertEqual(counts['needsReview'], 1)
        self.assertEqual(self.listing['id'], 'ah' + self.rule['pblancNo'])

    def test_changed_announcement_different_id_and_expiry_do_not_inherit(self):
        for key, value in [('announceDate', '2026-11-20'), ('houseManageNo', '999')]:
            entry = dict(self.listing, **{key: value})
            apply_reviews([entry], self.rules, lambda url: self.rule['source']['sha256'], NOW)
            self.assertFalse(entry['verified'])
        self.apply(now=NOW + timedelta(days=32))
        self.assertFalse(self.listing['verified'])

    def test_review_validation_rejects_mismatched_source_and_missing_evidence(self):
        for changes in [{'source': dict(self.rule['source'], url='https://example.com/private')},
                        {'source': dict(self.rule['source'], sha256='invalid')},
                        {'checks': {'housing': {'kind': 'none', 'page': 1}}}]:
            with self.assertRaises(ValueError):
                validate_rule(dict(self.rule, **changes))

    def test_pdf_reader_rejects_html_and_external_redirects(self):
        class Response:
            def __init__(self, body, host='static.applyhome.co.kr'):
                self.body, self.host = body, host
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def geturl(self): return 'https://' + self.host + '/file.pdf'
            def read(self, size): return self.body
        for response in [Response(b'error'), Response(b'%PDF-ok', 'example.com')]:
            with self.assertRaises(ValueError):
                pdf_digest('source', lambda *args, **kw: response)
        self.assertEqual(pdf_digest('source', lambda *a, **k: Response(b'%PDF-ok')), hashlib.sha256(b'%PDF-ok').hexdigest())


if __name__ == '__main__':
    unittest.main()
