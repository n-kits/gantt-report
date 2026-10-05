/*
 * Вкладка «Аналитика»: общие фильтры, разделы (Поток · Сроки · Люди · География), перерисовка.
 *   GanttAnalytics.mount()        — один раз, когда разметка вкладки на странице;
 *   GanttAnalytics.setData(json)  — данные analytics.json (на главной — после расшифровки, при каждом обновлении);
 *   GanttAnalytics.setVisible(v)  — вкладка открыта/скрыта: пока скрыта, обновления только запоминаются.
 * d3 нужен только графам связей и подгружается при первой отрисовке.
 */
(function (root) {
  'use strict';

  const A = root.GanttAnalytics;
  const D = A.dashboard;
  const { fmtN, dmy, dmhm, esc, addDays, span } = A.util;
  const KEY = 'gantt-analytics.v1';
  const D3_URL = 'https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js';
  const SLOTS = ['var(--an-s1)', 'var(--an-s2)', 'var(--an-s3)', 'var(--an-s4)', 'var(--an-s5)'];
  const ROLE_COLOR = { 'Картограф': 'var(--an-s1)', 'Дизайнер': 'var(--an-s2)' };
  const roleColor = r => ROLE_COLOR[r] || 'var(--an-other)';
  const DEFAULTS = { days: 14, project: '', product: '', person: '', beta: 0.85, betaPlaces: 0.85, minw: { people: 2, places: 1 }, winEnd: null };

  const $ = id => document.getElementById('an-' + id);
  let M = null, st = null, visible = false, dirty = false, d3wait = null, mounted = false;

  // --- состояние ------------------------------------------------------------
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { s = null; }
    s = Object.assign({}, DEFAULTS, s || {});
    s.minw = Object.assign({}, DEFAULTS.minw, s.minw || {});
    return s;
  }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* не критично */ } };

  // период «последние N дней» сдвигается вместе с архивом: пришёл новый день — он в периоде
  function clamp() {
    if (!st.to || st.follow) st.to = M.lastDay;
    if (!st.from) st.from = addDays(st.to, 1 - DEFAULTS.days);
    if (st.follow && st.len) st.from = st.len === 'all' ? M.firstDay : addDays(st.to, 1 - st.len);
    if (st.to > M.lastDay) st.to = M.lastDay;
    if (st.from < M.firstDay) st.from = M.firstDay;
    if (st.from > st.to) st.from = st.to;
  }

  function update(patch) {
    if ('from' in patch || 'to' in patch) { st.winEnd = null; st.follow = false; st.len = null; }
    Object.assign(st, patch);
    sync(); render();
  }

  // --- фильтры --------------------------------------------------------------
  function fillSelects() {
    const counts = A.util.countBy(M.tasks, t => t.project);
    $('project').innerHTML = '<option value="">Все</option>' +
      [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `<option value="${esc(p)}">${esc(p)} · ${n}</option>`).join('');
    $('product').innerHTML = '<option value="">Все</option>' + A.PRODUCTS.map(p => `<option value="${p.key}">${p.label}</option>`).join('');
  }

  function sync() {
    clamp();
    $('from').min = $('to').min = M.firstDay; $('from').max = $('to').max = M.lastDay;
    $('from').value = st.from; $('to').value = st.to; $('project').value = st.project; $('product').value = st.product;
    const days = span(st.from, st.to);
    document.querySelectorAll('#an-presets button').forEach(b => {
      const d = +b.dataset.days;
      b.setAttribute('aria-pressed', String(st.to === M.lastDay && (d ? days === d : st.from === M.firstDay)));
    });
    save();
  }

  function bind() {
    document.querySelectorAll('#an-presets button').forEach(b => b.addEventListener('click', () => {
      const d = +b.dataset.days;
      Object.assign(st, { to: M.lastDay, from: d ? addDays(M.lastDay, 1 - d) : M.firstDay, follow: true, len: d || 'all', winEnd: null });
      sync(); render();
    }));
    $('from').addEventListener('change', e => { if (e.target.value) update({ from: e.target.value }); });
    $('to').addEventListener('change', e => { if (e.target.value) update({ to: e.target.value }); });
    $('project').addEventListener('change', e => update({ project: e.target.value }));
    $('product').addEventListener('change', e => update({ product: e.target.value }));
    $('reset').addEventListener('click', () => {
      const keep = { beta: st.beta, betaPlaces: st.betaPlaces, minw: st.minw };
      st = Object.assign({}, DEFAULTS, keep, { follow: true, len: DEFAULTS.days, from: null, to: null });
      sync(); render();
    });
    // разделы — прокруткой, без смены адреса (адрес занят вкладкой)
    // с поправкой на липкую панель фильтров (на узком экране она в несколько строк)
    document.querySelectorAll('#an-nav button').forEach(b => b.addEventListener('click', () => {
      const bar = document.querySelector('.an-bar');
      const pad = getComputedStyle(bar).position === 'sticky' ? bar.offsetHeight + 8 : 8;
      scrollTo({ top: document.getElementById(b.dataset.sec).getBoundingClientRect().top + scrollY - pad, behavior: 'smooth' });
    }));
    // графы связей
    $('beta').addEventListener('input', e => { st.beta = +e.target.value; save(); graphs(); });
    $('beta-places').addEventListener('input', e => { st.betaPlaces = +e.target.value; save(); graphs(); });
    $('minw-people').addEventListener('input', e => { st.minw.people = +e.target.value; save(); graphs(); });
    $('minw-places').addEventListener('input', e => { st.minw.places = +e.target.value; save(); graphs(); });
    const shift = k => { st.winEnd = addDays(A.topWindow(st).to, k); save(); graphs(); };
    $('win-prev').addEventListener('click', () => shift(-1));
    $('win-next').addEventListener('click', () => shift(1));
    $('win-end').addEventListener('change', e => { if (e.target.value) { st.winEnd = e.target.value; save(); graphs(); } });
    $('person-clear').addEventListener('click', () => update({ person: '' }));
    let rt;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (visible) render(); else dirty = true; }, 150); });
  }

  // --- отрисовка ------------------------------------------------------------
  const filtered = () => M.tasks.filter(t => A.inRange(t, st.from, st.to) && A.byDims(st)(t));

  function status() {
    const s = A.statusAt(M, st.from, st.to);
    const parts = [`${dmy(st.from)} — ${dmy(st.to)}`];
    if (st.project) parts.push(st.project);
    if (st.product) parts.push(A.PRODUCTS.find(p => p.key === st.product).label);
    $('period').textContent = parts.join(' · ');
    // свежесть: последние 3 дня сверяются каждые 15 минут, более ранние (до 14 дней) — ночью
    $('status').innerHTML = s
      ? `статусы на <b>${dmhm(s.oldest)}</b>` + (s.newest.slice(0, 13) !== s.oldest.slice(0, 13) ? ` — ${dmhm(s.newest)}` : '')
      : 'статусы: нет данных';
    $('status').title = 'Задачи последних 3 дней сверяются с Bitrix при каждом запуске сборщика (раз в 15 минут), ' +
      'более ранние — раз в сутки после 04:00 на глубину 14 дней. В подсказке «Заказы по дням» — время сверки каждого дня.';
  }

  function ensureD3() {
    if (root.d3) return Promise.resolve();
    if (!d3wait) d3wait = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = D3_URL; s.onload = ok; s.onerror = () => fail(new Error('d3 не загрузился'));
      document.head.appendChild(s);
    });
    return d3wait;
  }

  function placeColors(groups) {
    const named = groups.slice(0, 3);
    const of = k => named.includes(k) ? SLOTS[named.indexOf(k)] : 'var(--an-other)';
    const others = groups.length - named.length;
    return { of, legend: named.map(k => `<span><span class="sw round" style="background:${of(k)}"></span>${esc(k)}</span>`).join('') +
      (others ? `<span><span class="sw round" style="background:var(--an-other)"></span>другие страны (${others})</span>` : '') };
  }
  function peopleColors(groups) {
    return { of: roleColor, legend: groups.map(k => `<span><span class="sw round" style="background:${roleColor(k)}"></span>${esc(k)}</span>`).join('') };
  }

  function graphs() {
    if (!root.d3) {
      $('people-graph').innerHTML = $('places-graph').innerHTML = '<div class="an-empty">Загрузка d3…</div>';
      ensureD3().then(graphs, e => { $('people-graph').innerHTML = $('places-graph').innerHTML = `<div class="an-empty">${esc(e.message)}</div>`; });
      return;
    }
    $('beta').value = st.beta; $('beta-v').textContent = st.beta.toFixed(2);
    $('beta-places').value = st.betaPlaces; $('beta-places-v').textContent = st.betaPlaces.toFixed(2);
    const list = filtered();
    // люди — за весь период
    const gp = A.graphPeople(M, list);
    const rp = A.bundling.draw($('people-graph'), gp, { beta: st.beta, minw: st.minw.people, pin: st.person, color: peopleColors, linkedOnly: true, partnersOnly: true,
      legend: $('people-legend'), table: $('people-table'), title: 'Кто с кем работает' });
    slider('people', rp.maxW);
    $('people-sub').textContent = `людей ${fmtN(rp.n)} · связей ${fmtN(rp.shown)} из ${fmtN(rp.total)}`;
    $('person-pin').hidden = !st.person;
    $('person-name').textContent = st.person;
    // топонимы — окно 7 дней внутри периода
    const w = A.topWindow(st);
    const inWin = M.tasks.filter(t => A.inRange(t, w.from, w.to) && A.byDims(st)(t));
    const gl = A.graphPlaces(M, inWin);
    const rl = A.bundling.draw($('places-graph'), gl, { beta: st.betaPlaces, minw: st.minw.places, color: placeColors, fitScreen: true,
      legend: $('places-legend'), table: $('places-table'), title: 'Какие места упоминаются вместе' });
    slider('places', rl.maxW);
    $('win-end').min = w.min; $('win-end').max = w.max; $('win-end').value = w.to;
    $('win-range').textContent = `${A.util.dm(w.from)}–${A.util.dm(w.to)}`;
    $('win-prev').disabled = w.to <= w.min; $('win-next').disabled = w.to >= w.max;
    $('places-sub').textContent = `заказов ${fmtN(inWin.length)} · мест ${fmtN(rl.n)} · связей ${fmtN(rl.shown)} из ${fmtN(rl.total)}` +
      (w.from < st.from ? ' · окно шире выбранного периода' : '');
  }
  function slider(k, maxW) {
    const el = $('minw-' + k);
    el.max = Math.max(2, Math.min(maxW, 30)); el.value = st.minw[k];
    $('minw-' + k + '-v').textContent = st.minw[k];
  }

  function render() {
    if (!M) return;
    if (!visible) { dirty = true; return; }
    dirty = false;
    const ctx = { M, st, list: filtered(), $, update, roleColor };
    status();
    D.kpis(ctx); D.days(ctx); D.projects(ctx); D.heat(ctx);
    D.lead(ctx); D.sla(ctx); D.margin(ctx);
    D.execs(ctx); D.geo(ctx);
    graphs();
  }

  // --- снаружи --------------------------------------------------------------
  function mount() {
    if (mounted) return;
    mounted = true;
    st = load();
    bind();
  }
  function setData(payload) {
    mount();
    M = A.prepare(payload);
    if (!M.lastDay) return;
    if (st.follow == null) { st.follow = true; st.len = DEFAULTS.days; }
    fillSelects(); sync();
    $('updated').textContent = M.generatedAt ? `данные на ${dmhm(M.generatedAt)}` : '';
    render();
  }
  function setVisible(v) {
    visible = !!v;
    if (visible && dirty) render();
  }

  Object.assign(A, { mount, setData, setVisible });
})(typeof window !== 'undefined' ? window : globalThis);
