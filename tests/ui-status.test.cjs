// 화면 렌더링 경로를 DOM 대역에서 실행한다. 시각적 레이아웃 검증은 별도다.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { resolve } = require('node:path');
const root = resolve(__dirname, '..');
const source = readFileSync(resolve(root, 'app.js'), 'utf8');
const original = JSON.parse(readFileSync(resolve(root, 'data/listings.json'), 'utf8'));

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
    innerWidth: 390, innerHeight: 844, addEventListener() {} };
  const context = { document, window, console, Date, setTimeout, clearTimeout,
    requestAnimationFrame(fn) { fn(); }, localStorage: { getItem() { return null; }, setItem() {} },
    fetch: async () => { if (report === null) throw Error('network'); return { ok: true, json: async () => report }; } };
  vm.runInNewContext(source, context, { filename: 'app.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, clickFilter(value) {
    handlers.click({ target: { closest(selector) {
      return selector === '[data-filter]' ? { getAttribute() { return value; } } : null;
    } } });
  } };
}

test('existing snapshot boots and shows unconfigured refresh', async () => {
  const { nodes } = await render({ status: 'not_configured' });
  assert.match(nodes.get('#syncStatus').textContent, /자동 갱신 준비 중/);
  assert.equal(nodes.get('#eligibleCount').textContent, 38);
  assert.match(nodes.get('#cards').innerHTML, /아르뮤제자이/);
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
  assert.match(nodes.get('#cards').innerHTML, /아르뮤제자이/);
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
