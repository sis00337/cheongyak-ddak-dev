/* 공고문에서 검토된 입력 조건만 비교한다. 최종 청약 자격을 확정하지 않는다. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CheongyakEligibility = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var regions = ['서울', '경기', '인천', '부산', '울산', '경남', '대구', '경북', '대전', '세종', '충북', '충남', '광주', '전북', '전남', '강원', '제주'];
  var labels = { housing: '세대 주택 수', residence: '거주 시도', deposit: '청약통장 예치금', householder: '세대주 여부' };

  function evaluate(listing, profile, status, now) {
    now = now || new Date();
    var today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    var review = listing.eligibility || {};
    var checked = Date.parse(review.checkedAt || '');
    var usable = review.state === 'reviewed' && review.validUntil >= today &&
      isFinite(checked) && now.getTime() - checked <= 30 * 3600000 && checked <= now.getTime() + 60000;
    var definitions = usable ? review.checks || {} : {};
    var rows = Object.keys(labels).map(function (key) {
      var rule = definitions[key];
      var row = { key: key, label: labels[key], status: 'unknown', text: '공고문에서 이 조건을 확인해야 합니다.' };
      if (!rule || !rule.quote || !Number.isInteger(rule.page) || rule.page < 1) return row;
      row.quote = rule.quote;
      row.page = rule.page;
      row.sourceUrl = review.sourceUrl;
      var input = profile[key];
      var pass;
      if (rule.kind === 'not_required') {
        row.status = 'not_applicable'; row.text = '이 공고는 해당 요건을 요구하지 않습니다.'; return row;
      }
      if (key === 'housing' && ['none', 'max_one'].indexOf(rule.kind) !== -1) {
        if (['무주택', '1주택', '2주택+'].indexOf(input) === -1) { row.text = '공고일 기준 세대 주택 수를 입력해 주세요.'; return row; }
        pass = rule.kind === 'none' ? input === '무주택' : input !== '2주택+';
        row.text = pass ? '입력한 세대 주택 수가 확인된 조건에 부합합니다.' : (rule.kind === 'none' ? '무주택세대구성원 요건에 맞지 않습니다.' : '확인된 주택 수 요건에 맞지 않습니다.');
      } else if (key === 'residence' && rule.kind === 'regions' && Array.isArray(rule.values) && rule.values.length && rule.values.every(function (v) { return regions.indexOf(v) !== -1; })) {
        if (regions.indexOf(input) === -1) { row.text = '공고일 기준 거주 시도를 선택해 주세요.'; return row; }
        pass = rule.values.indexOf(input) !== -1;
        row.text = pass ? '입력한 거주 시도가 확인된 지역 조건에 부합합니다.' : rule.values.join('·') + ' 거주 요건에 맞지 않습니다.';
      } else if (key === 'deposit' && rule.kind === 'minimum' && Number.isSafeInteger(rule.amountWon) && rule.amountWon > 0) {
        if (!Number.isSafeInteger(input) || input < 0) { row.text = '공고일 기준 예치금을 입력해 주세요.'; return row; }
        pass = input >= rule.amountWon;
        row.text = pass ? '입력한 예치금이 확인된 기준에 부합합니다.' : '예치금 ' + (rule.amountWon - input).toLocaleString('ko-KR') + '원 부족';
      } else if (key === 'householder' && rule.kind === 'required') {
        if (['세대주', '세대원'].indexOf(input) === -1) { row.text = '공고일 기준 세대주 여부를 선택해 주세요.'; return row; }
        pass = input === '세대주'; row.text = pass ? '입력한 세대주 조건이 부합합니다.' : '세대주 요건에 맞지 않습니다.';
      } else return row;
      row.status = pass ? 'pass' : 'fail';
      return row;
    });
    var fails = rows.filter(function (r) { return r.status === 'fail'; }).map(function (r) { return { text: r.label + ': ' + r.text }; });
    var passes = rows.filter(function (r) { return r.status === 'pass' || r.status === 'not_applicable'; }).map(function (r) { return r.label + ': ' + r.text; });
    var missing = rows.filter(function (r) { return r.status === 'unknown'; });
    var warnings = missing.map(function (r) { return r.label + ': ' + r.text; });
    if (!usable) warnings.unshift(review.reason || '현재 공고문과 대조된 자격 근거가 아직 없습니다.');
    if (usable) (review.manualChecks || []).forEach(function (r) { warnings.push(r.label + ': ' + r.note); });
    warnings.push('비교 결과는 입력한 조건에 한정됩니다. 최종 자격·예외·신청 제한은 공고문과 청약홈에서 확인하세요.');
    return { l: listing, status: status, checks: rows, fails: fails, passes: passes, warns: warnings,
      ok: !fails.length && !missing.length, unknown: !fails.length && !!missing.length,
      reviewUsable: usable, reviewedCount: Object.keys(definitions).length };
  }
  /* 만 원 단위 금액을 "6억 1,345만 원"처럼 읽기 쉽게 바꾼다. */
  function formatManwon(n) {
    if (n == null || !isFinite(n)) return '';
    n = Math.round(Number(n));
    if (n <= 0) return '0원';
    var eok = Math.floor(n / 10000), man = n % 10000;
    var parts = [];
    if (eok) parts.push(eok.toLocaleString('ko-KR') + '억');
    if (man) parts.push(man.toLocaleString('ko-KR') + '만');
    return parts.join(' ') + ' 원';
  }
  function formatPriceRange(min, max) {
    if (min == null) return '';
    if (max == null || max === min) return formatManwon(min);
    return formatManwon(min) + ' ~ ' + formatManwon(max);
  }

  /* 관심 공고 일정을 iCalendar(.ics) 종일 일정으로 만든다. 아이폰·구글 캘린더에서 바로 열린다. */
  function icsText(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
  }
  function icsDate(iso) { return String(iso).replace(/-/g, ''); }
  function nextDay(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }
  function fold(line) {
    /* RFC 5545: 75옥텟 이내로 접는다. 한글은 UTF-8 3바이트라 글자 수 기준 24자로 자른다. */
    var out = [], cur = '', bytes = 0;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i], b = ch.charCodeAt(0) < 0x80 ? 1 : 3;
      if (bytes + b > 73) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n');
  }
  function buildICS(listings, now) {
    now = now || new Date();
    var stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//cheongyak-ddak//ko', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:청약딱 관심 공고'];
    var dateRe = /^\d{4}-\d{2}-\d{2}$/;
    var today = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10); /* 지난 일정은 넣지 않는다 */
    (listings || []).forEach(function (L) {
      var events = [];
      if (dateRe.test(L.applyStart || '')) events.push({ key: 'start', date: L.applyStart, title: '접수 시작' });
      if (dateRe.test(L.applyEnd || '') && L.applyEnd !== L.applyStart) events.push({ key: 'end', date: L.applyEnd, title: '접수 마감' });
      else if (dateRe.test(L.applyEnd || '') && !events.length) events.push({ key: 'end', date: L.applyEnd, title: '접수 마감' });
      if (dateRe.test(L.winnersDate || '')) events.push({ key: 'winners', date: L.winnersDate, title: '당첨자 발표' });
      events.filter(function (ev) { return ev.date >= today; }).forEach(function (ev) {
        lines.push('BEGIN:VEVENT');
        lines.push('UID:' + icsText(L.id) + '-' + ev.key + '@cheongyak-ddak');
        lines.push('DTSTAMP:' + stamp);
        lines.push('DTSTART;VALUE=DATE:' + icsDate(ev.date));
        lines.push('DTEND;VALUE=DATE:' + nextDay(ev.date));
        lines.push(fold('SUMMARY:[' + ev.title + '] ' + icsText(L.name)));
        lines.push(fold('DESCRIPTION:' + icsText('청약딱에서 담은 공고입니다. 일정과 자격은 공고문 원문에서 확인하세요.')));
        if (L.detailUrl) lines.push(fold('URL:' + L.detailUrl));
        if (ev.key !== 'winners') {
          lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsText(ev.title), 'TRIGGER:-PT15H', 'END:VALARM');
        }
        lines.push('END:VEVENT');
      });
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  }

  return { evaluate: evaluate, regions: regions, formatManwon: formatManwon, formatPriceRange: formatPriceRange, buildICS: buildICS };
});

/* =========================================================
   청약딱 — 내 조건 맞춤 청약 필터 (전국판)
   정적 웹앱 (index.html + styles.css + app.js + data/listings.json)
   데이터: 청약홈(applyhome.co.kr) 전국 17개 시도 활성 공고
   ========================================================= */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  /* ───────────────────────── 상수 ───────────────────────── */
  var HOUSING = [
    { v: '무주택', l: '무주택' },
    { v: '1주택', l: '1주택' },
    { v: '2주택+', l: '2주택 이상' }
  ];
  /* 광역권을 묶으면 서로 다른 시도의 자격을 혼동할 수 있어 정확한 시도로 입력한다. */
  var E = window.CheongyakEligibility;
  var REGIONS = E.regions.map(function (r) { return { v: r, l: r, sidos: [r] }; });
  var HOUSEHOLDER = [
    { v: '세대주', l: '세대주' },
    { v: '세대원', l: '세대원' }
  ];
  var DEPOSIT_CHIPS = [
    { v: 0, l: '없음' },
    { v: 2000000, l: '200만' },
    { v: 2500000, l: '250만' },
    { v: 3000000, l: '300만' },
    { v: 3500000, l: '350만' },
    { v: 4000000, l: '400만' },
    { v: 4500000, l: '450만' },
    { v: 5000000, l: '500만+' }
  ];
  var DEP_MAX = 15000000;   /* 슬라이더 상한 1,500만 원 */
  var DEP_STEP = 100000;    /* 슬라이더 10만 원 단위 */
  var STORE_KEY = 'cheongyakddak:v4';
  var LEGACY_KEY = 'cheongyakddak:v3';
  var WD = ['일', '월', '화', '수', '목', '금', '토'];

  /* ───────────────────────── 상태 ───────────────────────── */
  var state = {
    housing: '',
    residence: '',
    deposit: null,          /* 원 단위. 미입력과 0원을 구분한다. */
    householder: '',
    filter: 'all',
    sort: 'deadline',
    favs: []
  };

  var LISTINGS = [];
  var META = {};
  var evalCache = [];
  var lastFocus = null;

  /* ───────────────────────── 유틸 ───────────────────────── */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) { return Number(n).toLocaleString('ko-KR'); }
  /* 금액은 앱 안에서 원 단위로 다룬다. */
  function won(n) { return num(Math.round(n)) + '원'; }
  function moneyLabel(n) {
    n = Math.round(n);
    if (n === 0) return '0원';
    if (n >= 10000 && n % 10000 === 0) return num(n / 10000) + '만 원';
    return num(n) + '원';
  }
  function moneyChip(n) {
    if (!n) return '없음';
    if (n >= 100000000) return num(Math.round(n / 100000000 * 10) / 10) + '억';
    if (n % 10000 === 0) return num(n / 10000) + '만';
    return won(n);
  }
  function parseWon(s) {
    var digits = String(s == null ? '' : s).replace(/[^0-9]/g, '');
    if (!digits) return null;
    return Math.min(Number(digits), 999999999);
  }
  function parseDate(iso) {
    if (!iso) return null;
    var d = new Date(iso + 'T00:00:00+09:00');
    return isNaN(d.getTime()) ? null : d;
  }
  function startOfToday() {
    var iso = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    return new Date(iso + 'T00:00:00+09:00');
  }
  function diffDays(a, b) { return Math.round((a.getTime() - b.getTime()) / 86400000); }
  function md(iso) {
    var d = parseDate(iso);
    if (!d) return '미정';
    return Number(iso.slice(5, 7)) + '/' + iso.slice(8, 10);
  }
  function mdw(iso) {
    var d = parseDate(iso);
    if (!d) return '미정';
    return md(iso) + '(' + WD[new Date(iso + 'T00:00:00Z').getUTCDay()] + ')';
  }
  function mySidos() {
    for (var i = 0; i < REGIONS.length; i++) {
      if (REGIONS[i].v === state.residence) return REGIONS[i].sidos;
    }
    return [];
  }
  function cross(a, b) {
    var out = [];
    (a || []).forEach(function (x) { if ((b || []).indexOf(x) !== -1) out.push(x); });
    return out;
  }
  function regionLabel(list) {
    if (!list || !list.length) return '확인 필요';
    if (list.length >= 17) return '전국';
    if (list.length === 3 && list.indexOf('서울') !== -1 && list.indexOf('경기') !== -1 && list.indexOf('인천') !== -1) {
      return '수도권(서울·경기·인천)';
    }
    return list.join('·');
  }

  function statusOf(L) {
    var today = startOfToday();
    var end = parseDate(L.applyEnd);
    var start = parseDate(L.applyStart) || end;
    if (!end) return { key: 'unknown', label: '일정 미확인', days: null };
    if (today > end) return { key: 'closed', label: '접수 마감', days: diffDays(end, today) };
    if (today < start) return { key: 'upcoming', label: 'D-' + diffDays(start, today), days: diffDays(start, today) };
    var left = diffDays(end, today);
    if (left === 0) return { key: 'open', label: '오늘 마감', days: 0, urgent: true };
    return { key: 'open', label: 'D-' + left, days: left, urgent: left <= 2 };
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        housing: state.housing,
        residence: state.residence,
        depositWon: state.deposit,
        householder: state.householder,
        favs: state.favs
      }));
    } catch (e) { /* 저장 실패는 무시 */ }
  }
  function load() {
    var s = null;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) s = JSON.parse(raw);
      if (!s) {
        /* 이전 버전의 자동 기본값은 사용자 확인값과 구분할 수 없어 관심 목록만 이관한다. */
        raw = localStorage.getItem(LEGACY_KEY);
        if (raw) {
          s = { favs: JSON.parse(raw).favs };
        }
      }
    } catch (e) { s = null; }
    if (!s) return;
    try {
      if (HOUSING.some(function (o) { return o.v === s.housing; })) state.housing = s.housing;
      if (REGIONS.some(function (o) { return o.v === s.residence; })) state.residence = s.residence;
      if (typeof s.depositWon === 'number' && isFinite(s.depositWon) && s.depositWon >= 0) {
        state.deposit = Math.min(Math.round(s.depositWon), 999999999);
      }
      if (HOUSEHOLDER.some(function (o) { return o.v === s.householder; })) state.householder = s.householder;
      if (Array.isArray(s.favs)) state.favs = s.favs.slice(0, 20);
    } catch (e) { /* 무시 */ }
  }

  /* ───────────────────────── 판정 ───────────────────────── */
  function evaluate(L) {
    return window.CheongyakEligibility.evaluate(L, state, statusOf(L));
  }

  function evaluateAll() { evalCache = LISTINGS.map(evaluate); return evalCache; }
  function byId(id) {
    for (var i = 0; i < LISTINGS.length; i++) if (LISTINGS[i].id === id) return LISTINGS[i];
    return null;
  }

  /* ───────────────────────── 조건 UI ───────────────────────── */
  function segHTML(list, current, name) {
    return list.map(function (o) {
      return '<button type="button" data-seg="' + name + '" data-value="' + esc(o.v) + '"' +
        ' aria-pressed="' + (o.v === current) + '">' + esc(o.l) + '</button>';
    }).join('');
  }

  function regionHTML() {
    return REGIONS.map(function (o) {
      return '<button type="button" class="region-btn" data-region="' + esc(o.v) + '"' +
        ' aria-pressed="' + (o.v === state.residence) + '">' + esc(o.l) + '</button>';
    }).join('');
  }

  function depositHint() {
    return '공고일 기준 예치금 · 공고 유형과 주택형에 따라 요건이 달라요';
  }

  function renderCondition() {
    $('#segHousing').innerHTML = segHTML(HOUSING, state.housing, 'housing');
    $('#segHouseholder').innerHTML = segHTML(HOUSEHOLDER, state.householder, 'householder');
    $('#segResidence').innerHTML = regionHTML();
    renderDeposit(true);
    renderMini();
  }

  /* 예치금 표시 — 버튼(50만)·슬라이더(10만)·직접 입력(원)을 같은 값에서 그린다. */
  function renderDeposit(syncInput) {
    var v = state.deposit;
    $('#depositValue').textContent = v == null ? '미입력' : won(v);
    $('#depositHint').textContent = depositHint();

    $('#depositChips').innerHTML = DEPOSIT_CHIPS.map(function (c) {
      var active = c.v === 5000000 ? v >= 5000000 : v === c.v;
      return '<button type="button" class="chip-btn" data-dep="' + c.v + '" aria-pressed="' + active + '">' +
        esc(c.l) + '</button>';
    }).join('');

    var range = $('#depositRange');
    var snapped = Math.round(v / DEP_STEP) * DEP_STEP;
    range.value = Math.max(0, Math.min(snapped, DEP_MAX));
    range.style.setProperty('--p', (Math.min(v, DEP_MAX) / DEP_MAX * 100) + '%');

    var inp = $('#depositInput');
    if (syncInput && document.activeElement !== inp) inp.value = v == null ? '' : num(v);
  }

  function setDeposit(v, opts) {
    state.deposit = v == null ? null : Math.max(0, Math.min(Math.round(v), 999999999));
    renderDeposit(!(opts && opts.keepInput));
    renderMini();
    evaluateAll();
    renderResults();
    save();
  }

  function renderMini() {
    $('#miniChips').innerHTML =
      '<span class="mini-chip"><b>' + esc(state.residence || '거주지 미입력') + '</b></span>' +
      '<span class="mini-chip"><b>' + esc(state.housing || '주택 수 미입력') + '</b></span>' +
      '<span class="mini-chip"><b>' + (state.deposit == null ? '예치금 미입력' : '예치금 ' + moneyChip(state.deposit)) + '</b></span>' +
      '<span class="mini-chip">' + esc(state.householder || '세대주 여부 미입력') + '</span>';
  }

  /* ───────────────────────── 결과 ───────────────────────── */
  function counts() {
    var ok = 0, open = 0;
    evalCache.forEach(function (e) {
      if (e.ok) {
        ok++;
        if (e.status.key === 'open' || e.status.key === 'upcoming') open++;
      }
    });
    var unknown = evalCache.filter(function (e) { return e.unknown; }).length;
    return { ok: ok, excluded: evalCache.length - ok - unknown, unknown: unknown, open: open, total: evalCache.length };
  }

  function conflictMap() {
    var groups = {}, map = {};
    state.favs.forEach(function (id) {
      var L = byId(id);
      if (!L || !L.winnersDate) return;
      (groups[L.winnersDate] = groups[L.winnersDate] || []).push(L);
    });
    Object.keys(groups).forEach(function (k) {
      if (groups[k].length > 1) groups[k].forEach(function (L) { map[L.id] = groups[k]; });
    });
    return { groups: groups, map: map };
  }

  function filterList() {
    var cm = conflictMap();
    return evalCache.filter(function (e) {
      if (state.filter === 'eligible') return e.ok;
      if (state.filter === 'excluded') return !e.ok && !e.unknown;
      if (state.filter === 'unknown') return e.unknown;
      if (state.filter === 'fav') return state.favs.indexOf(e.l.id) !== -1;
      return true;
    }).map(function (e) {
      return { e: e, conflict: !!cm.map[e.l.id] };
    });
  }

  function sortList(rows) {
    var s = state.sort;
    var rank = { open: 0, upcoming: 1, closed: 2, unknown: 3 };
    return rows.slice().sort(function (a, b) {
      var A = a.e, B = b.e;
      if (s === 'price') {
        var pa = A.l.priceMin, pb = B.l.priceMin;
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pa - pb;
      }
      if (s === 'units') {
        var ua = A.l.units, ub = B.l.units;
        if (ua == null && ub == null) return 0;
        if (ua == null) return 1;
        if (ub == null) return -1;
        return ub - ua;
      }
      if (s === 'announce') {
        var aa = A.l.winnersDate, ba = B.l.winnersDate;
        if (!aa && !ba) return 0;
        if (!aa) return 1;
        if (!ba) return -1;
        return aa < ba ? -1 : aa > ba ? 1 : 0;
      }
      if (s === 'region') {
        var ra0 = A.l.region || '', rb0 = B.l.region || '';
        if (ra0 !== rb0) return ra0 < rb0 ? -1 : 1;
      }
      /* deadline */
      var ra = rank[A.status.key], rb = rank[B.status.key];
      if (ra !== rb) return ra - rb;
      var ea = A.l.applyEnd, eb = B.l.applyEnd;
      if (!ea && !eb) return 0;
      if (!ea) return 1;
      if (!eb) return -1;
      return A.status.key === 'closed' ? (ea < eb ? 1 : -1) : (ea < eb ? -1 : 1);
    });
  }

  function reasonsFor(e) {
    if (e.checks) {
      var ordered = e.checks.slice().sort(function (a, b) { return ({ fail: 0, pass: 1, not_applicable: 1, unknown: 2 })[a.status] - ({ fail: 0, pass: 1, not_applicable: 1, unknown: 2 })[b.status]; });
      var shown = ordered.map(function (r) { return { t: r.status === 'fail' ? 'no' : r.status === 'unknown' ? 'warn' : 'ok', text: r.label + ': ' + r.text }; });
      return { shown: shown, extra: 0 };
    }
    var items = [];
    e.fails.forEach(function (f) { items.push({ t: 'no', text: f.text }); });
    e.warns.forEach(function (w) { items.push({ t: 'warn', text: w }); });
    e.passes.forEach(function (p) { items.push({ t: 'ok', text: p }); });
    var max = e.ok ? 3 : 2;
    return { shown: items.slice(0, max), extra: Math.max(0, items.length - max) };
  }

  function ddayClass(st) {
    if (st.key === 'open') return st.urgent ? 'dday dday--soon' : 'dday dday--open';
    if (st.key === 'upcoming') return 'dday dday--upcoming';
    if (st.key === 'closed') return 'dday dday--closed';
    return 'dday dday--unknown';
  }

  /* ─────────────────── 청약홈 신청 동선 ─────────────────── */
  function dateRange(a, b) {
    if (!a && !b) return '';
    if (!a || !b || a === b) return md(a || b);
    return md(a) + '~' + md(b);
  }

  function applyNote(L, st) {
    var bits = [];
    var range = dateRange(L.applyStart, L.applyEnd);
    if (st.key === 'upcoming') {
      if (L.applyStart) {
        bits.push('접수 시작 ' + mdw(L.applyStart) +
          (L.applyEnd && L.applyEnd !== L.applyStart ? ' · 마감 ' + md(L.applyEnd) : ''));
      } else {
        bits.push('접수일 미정');
      }
    } else if (st.key === 'closed') {
      bits.push(range ? '접수 ' + range + ' 마감' : '접수 마감');
    } else if (range) {
      bits.push('접수 ' + range);
      if (st.key === 'open' && st.days === 0) bits.push('오늘 17:30까지');
    }
    bits.push('청약홈 로그인 후 신청');
    return bits.join(' · ');
  }

  /* 카드·드로어의 버튼 하나만 상태에 따라 바뀐다: 신청 → 공고 보기(마감·미달) */
  function applyMeta(L, st, ok) {
    var applyUrl = L.applyUrl || '';
    var detailUrl = L.detailUrl || L.applyhomeUrl || '';
    var path = L.applyPath || '청약홈 청약신청';
    if (!L.verified || L.eligibilityStatus === 'needs_review') {
      return { kind: 'review', label: '자격 확인 필요 · 공고 보기', short: '공고 보기',
        url: detailUrl, path: path, tone: 'wait', note: '신청 자격과 접수 시간을 공고문에서 확인해 주세요.' };
    }
    if (ok && st.key === 'open' && applyUrl) {
      return { kind: 'apply', label: '청약홈에서 신청하기', short: '청약홈에서 신청 →',
        url: applyUrl, path: path, tone: 'go', note: applyNote(L, st) };
    }
    if (st.key === 'closed') {
      return { kind: 'closed', label: '접수 마감 · 공고 보기', short: '공고 보기',
        url: detailUrl, path: path, tone: 'muted', note: applyNote(L, st) };
    }
    if (ok && st.key === 'upcoming' && applyUrl) {
      return { kind: 'wait', label: '접수 D-' + st.days + ' · 공고 보기',
        short: '접수 D-' + st.days + ' · 공고 보기', url: detailUrl, path: path, tone: 'wait',
        note: applyNote(L, st) };
    }
    if (!ok) {
      return { kind: 'no', label: '입력 조건 확인 · 공고 보기', short: '공고 보기',
        url: detailUrl, path: path, tone: 'muted', note: '' };
    }
    return { kind: 'detail', label: '청약홈 공고 보기', short: '공고 보기',
      url: detailUrl, path: path, tone: 'muted', note: applyNote(L, st) };
  }

  function applyBoxHTML(e) {
    var L = e.l, st = e.status;
    var cta = applyMeta(L, st, e.ok);
    var alt = [];
    if (L.applyUrl && L.applyUrl !== cta.url) {
      alt.push('<a class="d-link" href="' + esc(L.applyUrl) + '" target="_blank" rel="noopener">' +
        esc(L.applyPath || '청약신청 화면') + ' ↗</a>');
    }
    return '<section class="d-sec d-apply">' +
      '<a class="apply-cta apply-cta--' + cta.tone + '" href="' + esc(cta.url) + '" target="_blank" rel="noopener">' +
        '<span class="apply-cta-label">' + esc(cta.label) + '</span>' +
        (cta.kind === 'apply' ? '<span class="apply-cta-arrow">→</span>' : '') +
      '</a>' +
      (cta.note ? '<p class="apply-note">' + esc(cta.note) + '</p>' : '') +
      (alt.length ? '<div class="apply-alt">' + alt.join('') + '</div>' : '') +
      '<p class="apply-fine">신청·전자서명은 청약홈에서 본인 인증(공동인증서·금융인증서) 후 직접 해야 해요. 이 앱은 신청을 대신하지 않아요.</p>' +
    '</section>';
  }

  function cardHTML(row) {
    var e = row.e, L = e.l, st = e.status;
    var isFav = state.favs.indexOf(L.id) !== -1;
    var rs = reasonsFor(e);

    var chips = '<span class="chip chip-region">' + esc(L.region) + '</span>' +
      '<span class="chip chip-type">' + esc(L.supplyType) + '</span>';
    if (row.conflict) chips += '<span class="chip chip-warn">발표일 중복</span>';
    if (!L.verified) chips += '<span class="chip chip-muted">원문 미확인</span>';

    var price = L.priceMin == null ? '가격 미확인' : (E.formatPriceRange(L.priceMin, L.priceMax) || L.priceRange);
    var priceLabel = L.priceLabel || '분양가';
    var units = L.units == null ? '물량 미확인' : num(L.units) + '세대';
    var dep = L.requiredDeposit == null ? '확인 필요' : L.requiredDeposit > 0 ? num(L.requiredDeposit) + '만' : '없음';

    var reasonsHTML = rs.shown.map(function (r) {
      var ico = r.t === 'no' ? '✕' : r.t === 'warn' ? '!' : '✓';
      return '<li class="r-' + r.t + '"><span class="r-ico">' + ico + '</span><span>' + esc(r.text) + '</span></li>';
    }).join('');
    if (rs.extra > 0) reasonsHTML += '<li class="r-more">외 ' + rs.extra + '가지 조건</li>';

    var announce = L.winnersDate ? '발표 <b>' + mdw(L.winnersDate) + '</b>' : '발표일 미정';
    var cta = applyMeta(L, st, e.ok);
    var applyRow = cta.kind === 'apply'
      ? '<a class="card-apply" data-apply href="' + esc(cta.url) + '" target="_blank" rel="noopener"' +
        ' aria-label="' + esc(L.name) + ' — 청약홈에서 신청">청약홈에서 신청하기 <b>→</b></a>'
      : '';

    return '' +
      '<article class="card' + (isFav ? ' is-fav' : '') + '" data-id="' + esc(L.id) + '" tabindex="0" role="button" ' +
      'aria-label="' + esc(L.name) + ' 상세 보기">' +
        '<div class="card-top">' +
          '<div class="card-chips">' + chips + '</div>' +
          '<span class="' + ddayClass(st) + '">' + esc(st.label) + '</span>' +
        '</div>' +
        '<h3 class="card-name">' + esc(L.name) + '</h3>' +
        '<p class="card-loc">' + esc(L.region) + ' ' + esc(L.district || '') + '</p>' +
        '<div class="card-facts">' +
          '<div class="card-fact"><span>' + esc(priceLabel) + '</span><b>' + esc(price) + '</b></div>' +
          '<div class="card-fact"><span>물량</span><b>' + esc(units) + '</b></div>' +
          '<div class="card-fact"><span>예치금</span><b>' + esc(dep) + '</b></div>' +
        '</div>' +
        '<div class="card-verdict">' +
          '<span class="verdict ' + (e.unknown ? 'verdict-review' : e.ok ? 'verdict-ok' : 'verdict-no') + '">' +
            (e.unknown ? '! 자격 확인 필요' : e.ok ? '✓ 입력 조건 부합' : '✕ 입력 조건 미달') +
          '</span>' +
        '</div>' +
        '<ul class="reasons">' + reasonsHTML + '</ul>' +
        applyRow +
        '<div class="card-foot">' +
          '<span class="card-announce">' + announce + '</span>' +
          '<div class="card-actions">' +
            '<button type="button" class="fav" data-fav="' + esc(L.id) + '" aria-pressed="' + isFav + '">' +
              '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5l-1.6-1.45C5.4 14.5 2.5 11.9 2.5 8.7 2.5 6.1 4.5 4 7.1 4c1.5 0 2.9.7 3.9 1.9C12 4.7 13.4 4 14.9 4 17.5 4 19.5 6.1 19.5 8.7c0 3.2-2.9 5.8-7.9 10.35L12 20.5z"/></svg>' +
              '관심' +
            '</button>' +
            '<span class="detail-btn">자세히 →</span>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function renderResults() {
    var c = counts();
    var labels = { all: '전체 공고', eligible: '입력 조건 부합', excluded: '입력 조건 미달', unknown: '자격 확인 필요', fav: '관심 공고' };
    $('#eligibleHead').textContent = labels[state.filter] || '전체 공고';
    $('#eligibleCount').textContent = filterList().length;
    $('#resultsSub').innerHTML =
      '입력 조건 부합 <b>' + c.ok + '건</b> · 조건 미달 ' + c.excluded + '건 · 자격 확인 필요 ' + c.unknown + '건' +
      '<br>원문 대조된 공고 ' + evalCache.filter(function (e) { return e.reviewUsable; }).length + '/' + c.total + '건 · 최종 자격은 별도 확인';

    $('#segFilter').innerHTML = [
      { v: 'eligible', l: '조건 부합', n: c.ok },
      { v: 'excluded', l: '조건 미달', n: c.excluded },
      { v: 'unknown', l: '확인 필요', n: c.unknown },
      { v: 'fav', l: '관심', n: state.favs.length },
      { v: 'all', l: '전체', n: c.total }
    ].map(function (o) {
      return '<button type="button" data-filter="' + o.v + '" aria-pressed="' + (state.filter === o.v) + '">' +
        o.l + ' <span class="seg-count">' + o.n + '</span></button>';
    }).join('');

    var rows = sortList(filterList());
    var host = $('#cards');
    if (!rows.length) {
      host.innerHTML = emptyHTML();
    } else {
      host.innerHTML = rows.map(cardHTML).join('');
    }

    renderOverlap();
    renderInterestBar();
  }

  function emptyHTML() {
    if (state.filter === 'all' || state.filter === 'unknown') {
      return '<div class="empty"><p class="empty-title">표시할 공고가 없어요</p><p class="empty-copy">갱신 상태와 청약홈 공고를 확인해 주세요.</p></div>';
    }
    if (state.filter === 'fav') {
      return '<div class="empty"><div class="empty-emoji">🤍</div>' +
        '<p class="empty-title">아직 담은 공고가 없어요</p>' +
        '<p class="empty-copy">카드의 <b>관심</b>을 눌러 두면<br>발표일이 겹치는지 한 번에 확인해 드려요.</p></div>';
    }
    if (state.filter === 'excluded') {
      return '<div class="empty"><div class="empty-emoji">🎉</div>' +
        '<p class="empty-title">조건 미달 공고가 없어요</p>' +
        '<p class="empty-copy">지금 조건으로 전국 공고를 모두 검토했어요.</p></div>';
    }
    return '<div class="empty"><div class="empty-emoji">🔍</div>' +
      '<p class="empty-title">지금 조건에 맞는 공고가 없어요</p>' +
      '<p class="empty-copy">입력값과 원문 검토 범위를 확인해 주세요.<br>확인 필요 탭에서 미확인 조건을 볼 수 있어요.</p>' +
      '<button type="button" class="empty-btn" data-edit-cond>조건 바꾸기</button></div>';
  }

  function renderOverlap() {
    var cm = conflictMap();
    var keys = Object.keys(cm.groups).filter(function (k) { return cm.groups[k].length > 1; });
    var host = $('#overlapBanner');

    if (keys.length) {
      var rows = keys.sort().map(function (k) {
        var names = cm.groups[k].map(function (L) { return L.name; });
        return '<p class="overlap-item"><b>' + mdw(k) + '</b> ' + esc(names.join(' · ')) +
          ' — 중복신청 제한과 예외를 각 공고문에서 확인하세요.</p>';
      }).join('');
      host.innerHTML = '<div class="overlap" role="status">' +
        '<span class="overlap-ico">!</span>' +
        '<div class="overlap-body">' +
          '<p class="overlap-title">당첨자 발표일이 겹칩니다 — 중복신청 제한 확인</p>' +
          '<div class="overlap-list">' + rows + '</div>' +
        '</div></div>';
      return;
    }
    if (state.favs.length >= 2) {
      host.innerHTML = '<div class="overlap overlap-ok" role="status">' +
        '<span class="overlap-ico">✓</span>' +
        '<div class="overlap-body">' +
          '<p class="overlap-title">관심 ' + state.favs.length + '곳 — 발표일이 모두 달라요</p>' +
          '<p class="overlap-item">발표일이 달라도 신청·당첨 제한이 있을 수 있어요. 각 공고문의 제한과 예외를 확인하세요.</p>' +
        '</div></div>';
      return;
    }
    host.innerHTML = '';
  }

  function renderInterestBar() {
    var bar = $('#interestBar');
    if (!state.favs.length) { bar.hidden = true; return; }
    bar.hidden = false;
    var cm = conflictMap();
    var conflictCount = Object.keys(cm.groups).filter(function (k) { return cm.groups[k].length > 1; }).length;
    $('#ibCount').textContent = state.favs.length;
    $('#ibSub').textContent = conflictCount
      ? '발표일 겹침 ' + conflictCount + '쌍 — 확인이 필요해요'
      : '발표일이 겹치는 공고가 없어요';
  }

  /* ───────────────────────── 드로어 ───────────────────────── */
  function timelineHTML(L, st) {
    var wd = L.winnersDate ? parseDate(L.winnersDate) : null;
    var wdLeft = wd ? diffDays(wd, startOfToday()) : null;
    var rows = [
      { k: '모집공고', v: L.announceDate ? md(L.announceDate) : '공고문 확인', side: '' },
      { k: '접수', v: L.applyDates || '공고문 확인', side: st.key === 'closed' ? '마감' : (L.applyStart ? md(L.applyStart) + '~' + md(L.applyEnd) : '') },
      { k: '당첨자 발표', v: L.winnersDate ? mdw(L.winnersDate) : '발표일 미정',
        side: wdLeft === null ? '' : (wdLeft < 0 ? '발표 완료' : wdLeft === 0 ? '오늘 발표' : 'D-' + wdLeft) },
      { k: '계약', v: L.contractStart ? mdw(L.contractStart) : '공고문 확인', side: L.contractStart ? '발표 후' : '' },
      { k: '입주', v: L.moveIn || '공고문 확인', side: '' }
    ];
    return rows.map(function (r) {
      return '<div class="d-tl-row"><span class="d-tl-label">' + r.k + '</span>' +
        '<span class="d-tl-value">' + esc(r.v) + '</span>' +
        '<span class="d-tl-side">' + esc(r.side) + '</span></div>';
    }).join('');
  }

  function typesHTML(L) {
    if (!L.types || !L.types.length) {
      return '<p class="fund-note">' + esc(L.priceRange || '공급 금액은 공고문·사업주체 문의로 확인해야 합니다.') + '</p>';
    }
    return '<table class="d-table"><thead><tr><th>주택형</th><th>공급 금액(최고가)</th></tr></thead><tbody>' +
      L.types.map(function (t) {
        return '<tr><td>' + esc(t.label) + '</td><td>' + esc(E.formatManwon(t.price)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function evidenceHTML(L) {
    if (L.eligibility && L.eligibility.state === 'reviewed') {
      var review = L.eligibility;
      return '<p class="review-meta">공고일 ' + esc(L.announceDate) + ' 기준 · 검토일 ' + esc(review.reviewedAt) + ' · 원본 대조 ' + esc(review.checkedAt) + '</p>' +
        '<p class="review-meta">소득·자산·나이·거주기간·신청 제한 등 전체 자격 검증을 완료했다는 뜻은 아닙니다.</p>';
    }
    var ev = L.evidence || {};
    var rows = [], seen = [];
    function add(k, v) {
      if (!v) return;
      var key = String(v).replace(/\s+/g, ' ').slice(0, 60);
      if (seen.indexOf(key) !== -1) return;
      seen.push(key);
      rows.push({ k: k, v: v });
    }
    add('주택 수', ev.housing);
    add('공고문 문구', ev.housing_alt);
    add('거주지', ev.residence);
    add('재당첨·전매', L.ruleNote);
    if (!rows.length) return '';
    return '<div class="d-quote">' + rows.map(function (r) {
      return '<p class="d-quote-row"><b>' + esc(r.k) + '</b> ' + esc(r.v) + '</p>';
    }).join('') + '</div>';
  }

  function conditionChecksHTML(e) {
    var labels = { pass: '입력 조건 부합', fail: '입력 조건 미달', unknown: '확인 필요', not_applicable: '해당 요건 없음' };
    return '<ul class="condition-checks">' + (e.checks || []).map(function (r) {
      var source = r.quote ? '<blockquote>' + esc(r.quote) + '</blockquote>' : '';
      if (r.page && r.sourceUrl) source += '<a href="' + esc(r.sourceUrl + '#page=' + r.page) + '" target="_blank" rel="noopener">공고문 ' + r.page + '쪽에서 확인 ↗</a>';
      return '<li class="condition-check condition-check--' + r.status + '"><div class="check-heading"><b>' + esc(r.label) + '</b><span>' + labels[r.status] + '</span></div><p>' + esc(r.text) + '</p>' + source + '</li>';
    }).join('') + '</ul>';
  }

  function drawerHTML(e) {
    var L = e.l, st = e.status;
    var isFav = state.favs.indexOf(L.id) !== -1;
    var verdictLines = (e.ok ? e.passes : e.fails).slice(0, 5).map(function (x) {
      var line = typeof x === 'string' ? x : x.text;
      return '<p class="dv-line">' + (e.ok ? '✓ ' : '✕ ') + esc(line) + '</p>';
    }).join('');
    var warnLines = e.warns.length
      ? '<div class="d-tip">' + e.warns.map(function (w) { return '· ' + esc(w); }).join('<br>') + '</div>'
      : '';

    var depositCell = L.requiredDeposit == null ? '공고문 확인 필요' : L.requiredDeposit > 0
      ? num(L.requiredDeposit) + '만 원' + (state.deposit < L.requiredDeposit * 10000
        ? ' <b style="color:var(--no)">(부족 ' + moneyLabel(L.requiredDeposit * 10000 - state.deposit) + ')</b>' : ' (충족)')
      : '요건 없음';

    var sourceLinks = '';
    if (L.pdfUrl) sourceLinks += '<a class="d-link" href="' + esc(L.pdfUrl) + '" target="_blank" rel="noopener">입주자모집공고문 PDF 열기 ↗</a>';
    if (L.detailUrl) {
      sourceLinks += '<a class="d-link" href="' + esc(L.detailUrl) + '" target="_blank" rel="noopener">청약홈 공고 상세 ↗</a>';
    } else {
      sourceLinks += '<a class="d-link" href="https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancListView.do" target="_blank" rel="noopener">청약홈에서 공고 검색 ↗</a>';
    }
    if (L.applyUrl) {
      sourceLinks += '<a class="d-link" href="' + esc(L.applyUrl) + '" target="_blank" rel="noopener">청약신청 화면 ↗</a>';
    }

    return '' +
      '<div class="drawer-head">' +
        '<div class="drawer-head-top">' +
          '<div class="card-chips">' +
            '<span class="chip chip-region">' + esc(L.region) + '</span>' +
            '<span class="chip chip-type">' + esc(L.supplyType) + '</span>' +
            '<span class="' + ddayClass(st) + '">' + esc(st.label) + '</span>' +
          '</div>' +
          '<button type="button" class="drawer-close" id="drawerClose" aria-label="닫기">✕</button>' +
        '</div>' +
        '<h2 class="drawer-title" id="drawerTitle">' + esc(L.name) + '</h2>' +
        '<p class="drawer-loc">' + esc(L.region) + ' ' + esc(L.district || '') + ' · ' +
          esc(L.units ? num(L.units) + '세대' : '물량 미확인') + '</p>' +
        '<div class="drawer-verdict ' + (e.unknown ? 'review' : e.ok ? 'ok' : 'no') + '">' +
          '<p class="dv-title">' + (e.unknown ? '! 신청 자격 확인 필요' : e.ok ? '✓ 입력 조건 부합 · 추가 자격 확인 필요' : '✕ 입력 조건 ' + e.fails.length + '가지 미달') + '</p>' +
          verdictLines +
        '</div>' +
      '</div>' +
      '<div class="drawer-body-inner">' +
        applyBoxHTML(e) +
        '<section class="d-sec">' +
          '<h3 class="d-sec-title">입력 조건별 확인 결과</h3>' +
          conditionChecksHTML(e) +
        '</section>' +
        '<section class="d-sec">' +
          '<h3 class="d-sec-title">공고문 원문 근거</h3>' +
          evidenceHTML(L) +
          warnLines +
        '</section>' +
        '<section class="d-sec">' +
          '<h3 class="d-sec-title">일정</h3>' +
          '<div class="d-timeline">' + timelineHTML(L, st) + '</div>' +
        '</section>' +
        '<section class="d-sec">' +
          '<h3 class="d-sec-title">공급 금액</h3>' +
          typesHTML(L) +
        '</section>' +
        '<section class="d-sec">' +
          '<h3 class="d-sec-title">신청 전 확인</h3>' +
          '<dl class="d-dl">' +
            '<div class="d-dl-row"><dt>주택 수 요건</dt><dd>' + esc(L.housingRequirement) + '</dd></div>' +
            '<div class="d-dl-row"><dt>청약통장 예치금</dt><dd>' + depositCell + '</dd></div>' +
            '<div class="d-dl-row"><dt>예치금 기준</dt><dd>' + esc(L.depositNote || '') + '</dd></div>' +
            '<div class="d-dl-row"><dt>거주지 요건</dt><dd>' +
              esc(L.residenceRequirement) + (L.eligibleRegions && L.eligibleRegions.length && L.residenceRequirement !== '전국'
                ? ' — ' + esc(regionLabel(L.eligibleRegions)) : '') +
              (L.priorityRegions && L.priorityRegions.length ? ' (우선 ' + esc(regionLabel(L.priorityRegions)) + ')' : '') +
            '</dd></div>' +
            '<div class="d-dl-row"><dt>세대주 조건</dt><dd>' +
              (L.householderOnly === true ? '무주택세대의 세대주만 가능'
                : L.householderOnly === false ? '세대주·세대원 모두 가능' : '공고문 확인') + '</dd></div>' +
            '<div class="d-dl-row"><dt>시행·시공</dt><dd>' + esc(L.builder || '—') + '</dd></div>' +
            '<div class="d-dl-row"><dt>문의처</dt><dd>' + esc(L.tel || '—') + '</dd></div>' +
          '</dl>' +
        '</section>' +
        '<section class="d-sec">' +
          '<h3 class="d-sec-title">원문 보기</h3>' +
          '<div class="d-links">' + sourceLinks + '</div>' +
          '<p class="d-source">출처 · 청약홈(applyhome.co.kr) ' + esc(L.source) + '<br>최종 자격과 일정은 공고문 원문으로 확인하세요.</p>' +
        '</section>' +
      '</div>' +
      '<div class="drawer-actions">' +
        '<button type="button" class="btn-secondary" id="drawerFav" aria-pressed="' + isFav + '">' +
          (isFav ? '관심 담김 ✓' : '관심 담기') + '</button>' +
        '<button type="button" class="btn-secondary" id="drawerCal" aria-label="캘린더에 추가">캘린더</button>' +
        '<a class="btn-primary" href="' + esc(applyMeta(L, st, e.ok).url) + '" target="_blank" rel="noopener">' +
          esc(applyMeta(L, st, e.ok).short) + '</a>' +
      '</div>';
  }

  function openDrawer(id) {
    var e = null;
    for (var i = 0; i < evalCache.length; i++) if (evalCache[i].l.id === id) { e = evalCache[i]; break; }
    if (!e) return;
    lastFocus = document.activeElement;
    var d = $('#drawer');
    d.innerHTML = drawerHTML(e);
    d.setAttribute('data-id', id);
    d.scrollTop = 0;
    d.hidden = false;
    $('#backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    var close = $('#drawerClose');
    if (close) close.focus();
  }

  function closeDrawer() {
    var d = $('#drawer');
    if (d.hidden) return;
    d.hidden = true;
    d.innerHTML = '';
    d.removeAttribute('data-id');
    $('#backdrop').hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  /* ───────────────────────── 관심 ───────────────────────── */
  function toggleFav(id) {
    var i = state.favs.indexOf(id);
    if (i === -1) state.favs.push(id);
    else state.favs.splice(i, 1);
    save();
    renderResults();
    return state.favs.indexOf(id) !== -1;
  }

  /* ───────────────────────── 캘린더 ───────────────────────── */
  function exportCalendar(list, filename) {
    var withDates = list.filter(function (L) { return L.applyStart || L.applyEnd || L.winnersDate; });
    if (!withDates.length) { toast('캘린더에 넣을 일정이 없어요'); return; }
    var ics = E.buildICS(withDates);
    var blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
    toast('일정 파일을 열면 캘린더에 추가돼요');
  }

  /* ───────────────────────── 토스트 ───────────────────────── */
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2400);
  }

  /* ───────────────────────── 미니 바 ───────────────────────── */
  function setupMiniBar() {
    var card = $('#condCard');
    var bar = $('#miniBar');
    var ticking = false;
    function check() {
      ticking = false;
      var rect = card.getBoundingClientRect();
      var threshold = Math.min(180, window.innerHeight * 0.25);
      var show = rect.bottom < threshold && window.innerWidth < 980;
      if (show !== !bar.hidden) bar.hidden = !show;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(check); }
    }, { passive: true });
    window.addEventListener('resize', check);
    check();
  }

  function refresh() {
    renderCondition();
    evaluateAll();
    renderResults();
  }

  /* ───────────────────────── 이벤트 ───────────────────────── */
  function bind() {
    document.addEventListener('click', function (ev) {
      /* 청약홈 링크는 새 창으로 열고, 카드 상세(드로어)는 열지 않는다 */
      if (ev.target.closest('[data-apply]')) return;

      var seg = ev.target.closest('[data-seg]');
      if (seg) {
        var key = seg.getAttribute('data-seg');
        var val = seg.getAttribute('data-value');
        if (state[key] !== val) { state[key] = val; save(); refresh(); }
        return;
      }

      var reg = ev.target.closest('[data-region]');
      if (reg) {
        var rv = reg.getAttribute('data-region');
        if (state.residence !== rv) { state.residence = rv; save(); refresh(); }
        return;
      }

      var dep = ev.target.closest('[data-dep]');
      if (dep) {
        setDeposit(Number(dep.getAttribute('data-dep')));
        return;
      }

      var fbtn = ev.target.closest('[data-filter]');
      if (fbtn) { state.filter = fbtn.getAttribute('data-filter'); renderResults(); return; }

      var favBtn = ev.target.closest('[data-fav]');
      if (favBtn) {
        ev.stopPropagation();
        var nowFav = toggleFav(favBtn.getAttribute('data-fav'));
        toast(nowFav ? '관심 공고에 담았어요' : '관심에서 뺐어요');
        return;
      }

      var card = ev.target.closest('.card');
      if (card) { openDrawer(card.getAttribute('data-id')); return; }

      if (ev.target.closest('[data-edit-cond]')) {
        $('#condCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (ev.target.id === 'miniEdit' || ev.target.closest('#miniEdit')) {
        $('#condCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (ev.target.id === 'drawerClose' || ev.target.id === 'drawerClose2' || ev.target.id === 'backdrop') {
        closeDrawer();
        return;
      }
      if (ev.target.id === 'drawerFav') {
        var id = $('#drawer').getAttribute('data-id');
        if (id) {
          var on = toggleFav(id);
          ev.target.setAttribute('aria-pressed', on);
          ev.target.textContent = on ? '관심 담김 ✓' : '관심 담기';
          var e2 = null;
          for (var i = 0; i < evalCache.length; i++) if (evalCache[i].l.id === id) { e2 = evalCache[i]; break; }
          if (e2) {
            var scroll = $('#drawer').scrollTop;
            $('#drawer').innerHTML = drawerHTML(e2);
            $('#drawer').setAttribute('data-id', id);
            $('#drawer').scrollTop = scroll;
          }
          toast(on ? '관심 공고에 담았어요' : '관심에서 뺐어요');
        }
        return;
      }
      if (ev.target.id === 'drawerCal') {
        var cid = $('#drawer').getAttribute('data-id');
        var one = byId(cid);
        if (one) exportCalendar([one], 'cheongyak-' + cid + '.ics');
        return;
      }
      if (ev.target.id === 'ibCal') {
        exportCalendar(state.favs.map(byId).filter(Boolean), 'cheongyak-favorites.ics');
        return;
      }
      if (ev.target.id === 'ibBtn') {
        state.filter = 'fav';
        renderResults();
        var target = $('#overlapBanner').children.length ? $('#overlapBanner') : $('#cards');
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    });

    $('#depositRange').addEventListener('input', function (ev) {
      setDeposit(Number(ev.target.value));
    });
    $('#depositRange').addEventListener('change', function () { save(); });

    /* 원 단위 직접 입력 — 타이핑하는 동안은 입력칸 글자를 그대로 두고 판정만 갱신한다 */
    var dInput = $('#depositInput');
    dInput.addEventListener('input', function (ev) {
      setDeposit(parseWon(ev.target.value), { keepInput: true });
    });
    dInput.addEventListener('blur', function () {
    dInput.value = state.deposit == null ? '' : num(state.deposit);
    });
    dInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); dInput.blur(); }
    });

    $('#sortSel').addEventListener('change', function (ev) {
      state.sort = ev.target.value;
      renderResults();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeDrawer();
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList && ev.target.classList.contains('card')) {
        ev.preventDefault();
        openDrawer(ev.target.getAttribute('data-id'));
      }
    });
  }

  /* ───────────────────────── 시작 ───────────────────────── */
  function boot(data) {
    LISTINGS = data.listings || [];
    META = data.meta || {};
    if (!Array.isArray(data.listings)) throw new Error('공고 데이터 형식 오류');

    $('#hdrCount').textContent = LISTINGS.length;
    if (META.collectedAt) {
      $('#hdrDate').textContent = META.collectedAt.replace(/-/g, '.');
      $('#footDate').textContent = META.collectedAt;
    }

    load();
    state.favs = state.favs.filter(function (id) { return !!byId(id); });
    renderCondition();
    evaluateAll();
    renderResults();
    setupMiniBar();
    bind();
    loadSyncStatus();
    registerServiceWorker();
  }

  /* 오프라인에서도 마지막으로 본 공고를 열 수 있게 한다. 웹 푸시의 전제이기도 하다. */
  function registerServiceWorker() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker || typeof location === 'undefined') return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  function renderSyncStatus(sync) {
    var host = $('#syncStatus');
    var updated = META.updatedAt || META.collectedAt;
    var parsed = updated ? new Date(updated.length === 10 ? updated + 'T00:00:00+09:00' : updated) : null;
    var stale = !parsed || isNaN(parsed.getTime()) || Date.now() - parsed.getTime() > 30 * 3600000;
    var time = parsed && !isNaN(parsed.getTime()) ? parsed.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '확인 불가';
    var message;
    var warning = true;
    if (!sync) message = '갱신 상태를 확인하지 못했습니다. 공고 원문을 확인해 주세요.';
    else if (sync.status === 'not_configured') message = '자동 갱신 준비 중입니다. 현재 저장된 공고를 표시합니다.';
    else if (sync.status === 'error') message = '최근 갱신에 실패했습니다. 이전 공고를 표시하니 일정은 원문에서 확인해 주세요.';
    else if (sync.status !== 'ok' || sync.lastSuccessAt !== META.updatedAt) message = '공고와 갱신 상태를 확인 중입니다. 잠시 후 다시 확인해 주세요.';
    else if (stale) message = '마지막 갱신 후 30시간 이상 지났습니다. 최신 일정은 공고 원문을 확인해 주세요.';
    else { message = '공식 공고 데이터 갱신 완료 · 신청 자격은 별도 확인이 필요합니다.'; warning = false; }
    host.className = 'sync-status' + (warning ? ' sync-status--warning' : '');
    host.textContent = message + ' 마지막 데이터 갱신: ' + time + ' (한국시간)';
    var source = $('#dataSourceNote');
    if (source) source.textContent = (META.source || '청약홈 입주자모집공고') + ' · 데이터 기준일 ' + (META.collectedAt || '확인 불가') + ' · 최종 자격과 일정은 공고문 원문으로 확인하세요.';
  }

  function loadSyncStatus() {
    renderSyncStatus(null);
    fetch('data/sync-status.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('상태 확인 실패'); return r.json(); })
      .then(renderSyncStatus).catch(function () { renderSyncStatus(null); });
  }

  function fail(msg) {
    $('#cards').innerHTML = '<div class="empty"><div class="empty-emoji">⚠️</div>' +
      '<p class="empty-title">공고 데이터를 불러오지 못했어요</p>' +
      '<p class="empty-copy">' + esc(msg) + '<br>로컬 서버에서 열어 주세요: <b>python3 -m http.server</b></p></div>';
  }

  if (window.__CHEONGYAK_DATA__) {
    boot(window.__CHEONGYAK_DATA__);
  } else {
    fetch('data/listings.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(boot)
      .catch(function (e) {
        fail('data/listings.json 을 읽을 수 없습니다 (' + e.message + ')');
      });
  }
})();
