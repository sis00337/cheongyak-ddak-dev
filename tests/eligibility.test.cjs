const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../app.js');
const now = new Date('2026-11-25T22:00:00+09:00');
const profile = { housing: '무주택', residence: '경기', deposit: 2000000, householder: '세대주' };
function listing(checks, extra = {}) {
  return { eligibility: { state: 'reviewed', checkedAt: now.toISOString(), validUntil: '2026-12-25',
    sourceUrl: 'https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do',
    checks, manualChecks: [{ label: '추가 확인', note: '재당첨 제한·나이·세대 범위 확인' }], ...extra } };
}
const rule = (kind, extra = {}) => ({ kind, page: 5, quote: '테스트용 명시 조건', ...extra });
const checks = { housing: rule('none'), residence: rule('regions', { values: ['서울', '경기', '인천'] }),
  deposit: rule('minimum', { amountWon: 2000000 }), householder: rule('required') };

test('four scoped matches retain unverified additional requirements', () => {
  const result = evaluate(listing(checks), profile, {}, now);
  assert.equal(result.ok, true);
  assert.match(result.warns.join(' '), /재당첨 제한/);
  assert.match(result.warns.join(' '), /최종 자격/);
});
test('each definite mismatch survives other missing requirements', () => {
  const result = evaluate(listing({ housing: rule('none') }), { ...profile, housing: '1주택' }, {}, now);
  assert.equal(result.fails.length, 1);
  assert.equal(result.unknown, false);
  assert.equal(result.ok, false);
});
test('null deposit stays unknown; zero explicitly fails a minimum; equality passes', () => {
  for (const [deposit, expected] of [[null, 'unknown'], [0, 'fail'], [1999999, 'fail'], [2000000, 'pass']]) {
    assert.equal(evaluate(listing(checks), { ...profile, deposit }, {}, now).checks[2].status, expected);
  }
});
test('waived account requirement needs no input and says only that condition is waived', () => {
  const result = evaluate(listing({ deposit: rule('not_required') }), {}, {}, now);
  assert.equal(result.checks[2].status, 'not_applicable');
  assert.equal(result.unknown, true);
  assert.equal(result.ok, false);
});
test('ambiguous regional groups are unknown rather than partial matches', () => {
  assert.equal(evaluate(listing(checks), { ...profile, residence: '강원·제주' }, {}, now).checks[1].status, 'unknown');
  assert.equal(evaluate(listing(checks), { ...profile, residence: '부산' }, {}, now).checks[1].status, 'fail');
});
test('missing evidence, unknown rule types and legacy verified flags never pass', () => {
  for (const value of [{ verified: true, housingRequirement: '무관' }, listing({ housing: { kind: 'none' } }), listing({ housing: rule('guessed') })]) {
    assert.equal(evaluate(value, profile, {}, now).ok, false);
  }
});
test('expired review and stale original comparison disable all rules', () => {
  for (const extra of [{ validUntil: '2026-11-24' }, { checkedAt: '2026-11-23T00:00:00+09:00' }, { state: 'needs_review' }]) {
    const result = evaluate(listing(checks, extra), profile, {}, now);
    assert.equal(result.reviewUsable, false);
    assert.equal(result.passes.length, 0);
  }
});
test('rejected head requirement and household count use explicit input only', () => {
  assert.equal(evaluate(listing(checks), { ...profile, householder: '세대원' }, {}, now).checks[3].status, 'fail');
  assert.equal(evaluate(listing(checks), { ...profile, housing: '' }, {}, now).checks[0].status, 'unknown');
});
