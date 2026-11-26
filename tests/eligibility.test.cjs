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

const { formatManwon, formatPriceRange, buildICS } = require('../app.js');

test('man-won amounts read as 억/만', () => {
  assert.equal(formatManwon(61345), '6억 1,345만 원');
  assert.equal(formatManwon(85000), '8억 5,000만 원');
  assert.equal(formatManwon(120000), '12억 원');
  assert.equal(formatManwon(9500), '9,500만 원');
  assert.equal(formatManwon(null), '');
  assert.equal(formatPriceRange(61345, 85406), '6억 1,345만 원 ~ 8억 5,406만 원');
  assert.equal(formatPriceRange(9500, 9500), '9,500만 원');
});

test('calendar export has all-day events for apply and winners dates', () => {
  const ics = buildICS([{ id: 'x1', name: '테스트, 공고', applyStart: '2026-11-30', applyEnd: '2026-12-02',
    winnersDate: '2026-12-09', detailUrl: 'https://www.applyhome.co.kr/' }], new Date('2026-11-26T00:00:00Z'));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);
  assert.match(ics, /DTSTART;VALUE=DATE:20261202\r\nDTEND;VALUE=DATE:20261203/);
  assert.match(ics, /DTEND;VALUE=DATE:20261210/);
  assert.match(ics, /테스트\\, 공고/);
  assert.match(ics, /UID:x1-winners@cheongyak-ddak/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
});

test('calendar export skips listings without valid dates', () => {
  const ics = buildICS([{ id: 'x2', name: '날짜 없음', applyStart: '', applyEnd: '공고문 확인' }]);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 0);
});

test('calendar export leaves out dates already past in Korea', () => {
  const ics = buildICS([{ id: 'x3', name: '진행 중', applyStart: '2026-11-23', applyEnd: '2026-11-27', winnersDate: '2026-12-03' }],
    new Date('2026-11-26T00:00:00Z'));
  assert.doesNotMatch(ics, /x3-start/);
  assert.match(ics, /x3-end/);
});

const { standardDeposit, smallestArea } = require('../app.js');

test('standard deposit table follows residence group and smallest unit', () => {
  assert.equal(standardDeposit('서울', 59.71), 3000000);
  assert.equal(standardDeposit('부산', 101), 6000000);
  assert.equal(standardDeposit('대구', 84.9), 2500000);
  assert.equal(standardDeposit('경기', 120), 4000000);
  assert.equal(standardDeposit('제주', 140), 5000000);
  assert.equal(smallestArea({ types: [{ label: '084.9500A' }, { label: '059.7100A' }] }), 59.71);
  assert.equal(smallestArea({ types: [{ label: '오피스텔' }] }), null);
});

test('auto-analysed listing uses its evidence and computes the standard deposit', () => {
  const now = new Date('2026-11-26T09:00:00Z');
  const listing = { types: [{ label: '059.7100A' }], eligibility: { state: 'auto', checkedAt: now.toISOString(), validUntil: '2026-12-31',
    sourceUrl: 'https://static.applyhome.co.kr/x', checks: {
      housing: { kind: 'none', page: 2, quote: '무주택세대구성원' },
      residence: { kind: 'regions', values: ['서울'], page: 2, quote: '서울특별시 거주' },
      deposit: { kind: 'standard_table', page: 3, quote: '지역별 예치금액' },
      householder: { kind: 'required', page: 2, quote: '세대주' } },
    manualChecks: [{ label: '재당첨', note: '확인', page: 3 }] } };
  const ok = evaluate(listing, { housing: '무주택', residence: '서울', deposit: 3000000, householder: '세대주' }, {}, now);
  assert.equal(ok.ok, true);
  assert.equal(ok.reviewUsable, true);
  const short = evaluate(listing, { housing: '무주택', residence: '서울', deposit: 2000000, householder: '세대주' }, {}, now);
  assert.equal(short.ok, false);
  assert.match(short.fails[0].text, /1,000,000원 부족/);
});
