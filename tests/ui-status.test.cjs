// 화면 렌더링 경로를 DOM 대역에서 실행한다. 시각적 레이아웃 검증은 별도다.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
require('./eligibility.test.cjs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
const source = readFileSync(resolve(root, 'app.js'), 'utf8');
// 매일 바뀌는 운영 공고 수와 이름에 테스트를 의존시키지 않는다.
const original = { meta: { collectedAt: '2026-11-25' }, listings: [{
  id: 'fixture-1', name: '테스트 공고', region: '경기', supplyType: 'APT',
  applyStart: '2026-11-25', applyEnd: '2026-11-30', winnersDate: '2026-12-03',
  verified: false, requiredDeposit: null, priceMin: null,
  detailUrl: 'https://www.applyhome.co.kr/', eligibilityStatus: 'needs_review'
}] };

async function render(report, meta = {}, listings = original.listings) {
  const nodes = new Map();
  const handlers = {};
  function element() {
    return { textContent: '', innerHTML: '', hidden: true, style: { setProperty() {} }, children: [], value: '',
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, removeAttribute() {}, getAttribute() { return ''; },
      addEventListener() {}, querySelectorAll() { return []; },
      getBoundingClientRect() { return { bottom: 500 }; }, focus() {} };
  }
  const document = {
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { handlers[type] = fn; }, body: element(), activeElement: null
  };
  const window = { __CHEONGYAK_DATA__: { meta: { ...original.meta, ...meta }, listings },
    CheongyakEligibility: require('../app.js'),
    innerWidth: 390, innerHeight: 844, addEventListener() {} };
  const context = { document, window, console, Date, setTimeout, clearTimeout,
    requestAnimationFrame(fn) { fn(); }, localStorage: { getItem() { return null; }, setItem() {} },
    fetch: async () => { if (report === null) throw Error('network'); return { ok: true, json: async () => report }; } };
  vm.runInNewContext(source, context, { filename: 'app.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, openCard(id) {
    handlers.click({ target: { closest(selector) {
      return selector === '.card' ? { getAttribute() { return id; } } : null;
    } } });
  }, clickFilter(value) {
    handlers.click({ target: { closest(selector) {
      return selector === '[data-filter]' ? { getAttribute() { return value; } } : null;
    } } });
  } };
}

test('existing snapshot boots and shows unconfigured refresh', async () => {
  const { nodes } = await render({ status: 'not_configured' });
  assert.match(nodes.get('#syncStatus').textContent, /자동 갱신 준비 중/);
  assert.equal(nodes.get('#eligibleCount').textContent, 1);
  assert.match(nodes.get('#cards').innerHTML, /테스트 공고/);
  assert.equal(nodes.get('#depositValue').textContent, '미입력');
  assert.doesNotMatch(nodes.get('#segHousing').innerHTML, /aria-pressed="true"/);
  assert.match(nodes.get('#segResidence').innerHTML, /data-region="충북"/);
  assert.doesNotMatch(nodes.get('#segResidence').innerHTML, /data-region="강원·제주"/);
});

test('reviewed drawer displays each condition and links to the evidence page', async () => {
  const stamp = new Date().toISOString();
  const listing = { ...original.listings[0], verified: true, eligibilityStatus: 'partial_review',
    eligibility: { state: 'reviewed', checkedAt: stamp, reviewedAt: stamp.slice(0, 10), validUntil: '2099-01-01',
      sourceUrl: 'https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?test=1',
      checks: { deposit: { kind: 'not_required', page: 5, quote: '청약통장 가입여부와 무관' } },
      manualChecks: [{ label: '신청 제한', note: '추가 확인 필요' }] } };
  const view = await render({ status: 'not_configured' }, {}, [listing]);
  view.openCard(listing.id);
  const html = view.nodes.get('#drawer').innerHTML;
  assert.match(html, /입력 조건별 확인 결과/);
  assert.match(html, /공고문 5쪽에서 확인/);
  assert.match(html, /#page=5/);
  assert.match(html, /신청 제한: 추가 확인 필요/);
  assert.doesNotMatch(html, /내 조건으로는 0가지 미달/);
});

test('unknown eligibility stays visible and is not classified as failed', async () => {
  const listing = { ...original.listings[0], verified: false, requiredDeposit: null, eligibilityStatus: 'needs_review' };
  const view = await render({ status: 'not_configured' }, {}, [listing]);
  assert.match(view.nodes.get('#cards').innerHTML, /자격 확인 필요/);
  assert.doesNotMatch(view.nodes.get('#cards').innerHTML, /✓ 지원 가능|✕ 조건 미달/);
  view.clickFilter('excluded');
  assert.equal(view.nodes.get('#eligibleCount').textContent, 0);
  view.clickFilter('unknown');
  assert.equal(view.nodes.get('#eligibleCount').textContent, 1);
});

test('matching fresh success is displayed without warning', async () => {
  const stamp = new Date().toISOString();
  const { nodes } = await render({ status: 'ok', lastSuccessAt: stamp }, { updatedAt: stamp });
  assert.equal(nodes.get('#syncStatus').className, 'sync-status');
  assert.match(nodes.get('#syncStatus').textContent, /갱신 완료/);
});

test('failure preserves displayed listings and shows warning', async () => {
  const { nodes } = await render({ status: 'error' });
  assert.match(nodes.get('#syncStatus').textContent, /최근 갱신에 실패/);
  assert.match(nodes.get('#cards').innerHTML, /테스트 공고/);
});

test('stale data, mismatched snapshots, missing status are distinct', async () => {
  const old = '2020-01-01T09:37:00+09:00';
  const stale = await render({ status: 'ok', lastSuccessAt: old }, { updatedAt: old });
  assert.match(stale.nodes.get('#syncStatus').textContent, /30시간 이상/);
  const mismatch = await render({ status: 'ok', lastSuccessAt: old }, { updatedAt: new Date().toISOString() });
  assert.match(mismatch.nodes.get('#syncStatus').textContent, /공고와 갱신 상태를 확인 중/);
  const missing = await render(null);
  assert.match(missing.nodes.get('#syncStatus').textContent, /갱신 상태를 확인하지 못/);
});

test('no placeholder ad cards are rendered between listings', async () => {
  const many = [1, 2, 3, 4].map(n => ({ ...original.listings[0], id: 'fixture-' + n, name: '테스트 공고 ' + n }));
  const { nodes } = await render({ status: 'not_configured' }, {}, many);
  assert.doesNotMatch(nodes.get('#cards').innerHTML, /ad-card|광고/);
});

test('drawer offers a calendar export for the listing', async () => {
  const view = await render({ status: 'not_configured' });
  view.openCard('fixture-1');
  assert.match(view.nodes.get('#drawer').innerHTML, /id="drawerCal"/);
});
