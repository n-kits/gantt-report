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
  const PLOT_URL = 'https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/dist/plot.umd.min.js';   // нужен d3
  const SANKEY_URL = 'https://cdn.jsdelivr.net/npm/d3-sankey@0.12.3/dist/d3-sankey.min.js';           // дописывает себя в d3
  const SLOTS = ['var(--an-s1)', 'var(--an-s2)', 'var(--an-s3)', 'var(--an-s4)', 'var(--an-s5)'];
  const ROLE_COLOR = { 'Картограф': 'var(--an-s1)', 'Дизайнер': 'var(--an-s2)' };
  const roleColor = r => ROLE_COLOR[r] || 'var(--an-other)';
  const DEFAULTS = { mode: '', gran: 'auto', days: 14, project: null, product: null, person: '', place: '', beta: 0.85, betaPlaces: 0.85, minw: { people: 2, places: 1 }, winEnd: null, marginView: 'bars', marginRows: 'project', sankeyMode: 'full' };

  const $ = id => document.getElementById('an-' + id);

  // «Сегодня» — для всех с 20.11.2026 (до этого — на пробу за флагом ?today=1); метку пробного периода убираем
  try { localStorage.removeItem('gantt-analytics.today'); } catch (e) { /* не критично */ }
  let M = null, st = null, visible = false, dirty = false, d3wait = null, plotWait = null, sankeyWait = null, mounted = false;

  // --- состояние ------------------------------------------------------------
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { s = null; }
    s = Object.assign({}, DEFAULTS, s || {});
    s.minw = Object.assign({}, DEFAULTS.minw, s.minw || {});
    s.project = A.asFilter(s.project);
    s.product = A.asFilter(s.product);
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
    if ('from' in patch || 'to' in patch) { st.winEnd = null; st.follow = false; st.len = null; st.mode = ''; }
    Object.assign(st, patch);
    sync(); render();
  }

  // --- фильтры --------------------------------------------------------------
  // выпадающий мультивыбор: «Только выбранные» / «Все, кроме», галочки с числом заказов, поиск на длинном списке
  const productName = k => (A.PRODUCTS.find(p => p.key === k) || { label: k }).label;
  // число заказов в списке — за выбранный период (без учёта самих фильтров), проекты без заказов в периоде — в конце
  const inPeriod = () => M.tasks.filter(t => A.inRange(t, st.from, st.to));
  const MS = {
    project: { title: 'Проект', name: k => k, options: () => { const c = A.util.countBy(inPeriod(), t => t.project, A.util.W), all = A.util.countBy(M.tasks, t => t.project, A.util.W);
      return [...all.keys()].map(k => ({ key: k, label: k, n: c.get(k) || 0, all: all.get(k) })).sort((a, b) => b.n - a.n || b.all - a.all); } },
    product: { title: 'Вид продукции', name: productName, options: () => { const c = A.util.countBy(inPeriod(), t => t.pkey, A.util.W); return A.PRODUCTS.map(p => ({ key: p.key, label: p.label, n: c.get(p.key) || 0 })); } },
  };
  let msOpen = null;
  function msClose() { if (!msOpen) return; $(msOpen).querySelector('.an-ms-pop').hidden = true; $(msOpen).querySelector('.an-ms-btn').setAttribute('aria-expanded', 'false'); msOpen = null; }
  function msRender(k) {
    const el = $(k), cfg = MS[k], f = st[k];
    const lbl = A.filterLabel(f, cfg.name);
    el.querySelector('.an-ms-btn').innerHTML = `<span class="an-ms-v">${esc(lbl || 'Все')}</span>` +
      `<svg class="an-ms-caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    el.querySelector('.an-ms-btn').title = A.isOn(f) ? (f.mode === 'out' ? 'Все, кроме: ' : 'Только: ') + f.items.map(cfg.name).join(', ') : 'Все';
    const pop = el.querySelector('.an-ms-pop');
    if (pop.hidden) return;
    const q = (pop.querySelector('.an-ms-q') || {}).value || '';
    pop.querySelectorAll('.an-ms-mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === f.mode)));
    const opts = cfg.options().filter(o => !q || o.label.toLowerCase().includes(q.toLowerCase()));
    pop.querySelector('.an-ms-list').innerHTML = opts.map(o =>
      `<label><input type="checkbox" value="${esc(o.key)}"${f.items.includes(o.key) ? ' checked' : ''}><span>${esc(o.label)}</span><small>${A.util.fmtN(o.n)}</small></label>`).join('') ||
      '<div class="an-ms-none">Ничего не найдено</div>';
  }
  function msMount(k) {
    const el = $(k), cfg = MS[k];
    el.innerHTML = `<button type="button" class="an-ms-btn" aria-haspopup="true" aria-expanded="false"></button>` +
      `<div class="an-ms-pop" hidden>` +
      `<div class="an-seg an-ms-mode" role="group" aria-label="Как выбирать"><button type="button" data-m="in">Только выбранные</button><button type="button" data-m="out">Все, кроме</button></div>` +
      (k === 'project' ? '<input class="an-ms-q" type="search" placeholder="Найти проект">' : '') +
      `<div class="an-ms-list"></div><div class="an-ms-foot"><button type="button" class="an-link an-ms-clear">Сбросить</button><button type="button" class="an-link an-ms-done">Готово</button></div></div>`;
    const pop = el.querySelector('.an-ms-pop');
    // подпись «Проект» / «Вид продукции» тоже открывает список — как у прежнего <label><select>
    // (сам щелчок по подписи дальше не идёт — иначе общий обработчик «щелчок мимо» тут же закрыл бы список)
    el.parentElement.addEventListener('click', e => { if (e.target === el.parentElement) { e.stopPropagation(); el.querySelector('.an-ms-btn').click(); } });
    el.querySelector('.an-ms-btn').addEventListener('click', () => {
      const was = msOpen === k;
      msClose();
      if (was) return;
      msOpen = k; pop.hidden = false; el.querySelector('.an-ms-btn').setAttribute('aria-expanded', 'true');
      // у правого края экрана (телефон) — сдвинуть список влево, чтобы не вылезал за экран
      pop.style.left = '';
      const over = pop.getBoundingClientRect().right - (document.documentElement.clientWidth - 8);
      if (over > 0) pop.style.left = `${-over}px`;
      msRender(k);
      const q = pop.querySelector('.an-ms-q'); if (q) { q.value = ''; msRender(k); }
    });
    pop.querySelectorAll('.an-ms-mode button').forEach(b => b.addEventListener('click', () => update({ [k]: { mode: b.dataset.m, items: st[k].items.slice() } })));
    pop.querySelector('.an-ms-list').addEventListener('change', e => {
      const v = e.target.value, items = e.target.checked ? [...st[k].items, v] : st[k].items.filter(x => x !== v);
      update({ [k]: { mode: st[k].mode, items } });
    });
    const q = pop.querySelector('.an-ms-q'); if (q) q.addEventListener('input', () => msRender(k));
    pop.querySelector('.an-ms-clear').addEventListener('click', () => update({ [k]: A.noFilter() }));
    pop.querySelector('.an-ms-done').addEventListener('click', msClose);
  }
  function fillSelects() { msRender('project'); msRender('product'); }

  function sync() {
    clamp();
    $('from').min = $('to').min = M.firstDay; $('from').max = $('to').max = M.lastDay;
    $('from').value = st.from; $('to').value = st.to; msRender('project'); msRender('product');
    // стрелки сдвига периода: на его длину (Shift — на день); у края архива — неактивны
    const n = span(st.from, st.to), word = `${n} ${A.util.plural(n, ['день', 'дня', 'дней'])}`;
    if ($('prev') && $('next')) {
      $('prev').disabled = st.from <= M.firstDay; $('next').disabled = st.to >= M.lastDay;
      $('prev').title = `На ${word} раньше (Shift — на день)`; $('next').title = `На ${word} позже (Shift — на день)`;
    }
    const days = span(st.from, st.to);
    document.querySelectorAll('#an-presets button').forEach(b => {
      if (b.dataset.days === 'today') { b.setAttribute('aria-pressed', String(st.mode === 'today')); return; }
      const d = +b.dataset.days;
      b.setAttribute('aria-pressed', String(st.mode !== 'today' && st.to === M.lastDay && (d ? days === d : st.from === M.firstDay)));
    });
    save();
  }

  function bind() {
    document.querySelectorAll('#an-presets button').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.days === 'today') { st.mode = 'today'; sync(); render(); return; }
      const d = +b.dataset.days;
      Object.assign(st, { mode: '', to: M.lastDay, from: d ? addDays(M.lastDay, 1 - d) : M.firstDay, follow: true, len: d || 'all', winEnd: null });
      sync(); render();
    }));
    // сдвиг периода целиком: длина сохраняется, у края архива период упирается в край
    const shiftPeriod = dir => e => {
      const n = span(st.from, st.to), k = (e.shiftKey ? 1 : n) * dir;
      let from = addDays(st.from, k), to = addDays(st.to, k);
      if (from < M.firstDay) { from = M.firstDay; to = addDays(from, n - 1); }
      if (to > M.lastDay) { to = M.lastDay; from = addDays(to, 1 - n); }
      if (from < M.firstDay) from = M.firstDay;
      update({ from, to });
    };
    // ?. — после выкладки браузер может какое-то время держать старый index.html без стрелок: вкладка не должна падать
    $('prev')?.addEventListener('click', shiftPeriod(-1));
    $('next')?.addEventListener('click', shiftPeriod(1));
    $('from').addEventListener('change', e => { if (e.target.value) update({ from: e.target.value }); });
    $('to').addEventListener('change', e => { if (e.target.value) update({ to: e.target.value }); });
    msMount('project'); msMount('product');
    // закрыть список: щелчок мимо, Esc
    // путь события — на момент щелчка: кнопка при открытии перерисовывает свою надпись, и e.target к этому
    // времени уже вне документа — по contains() щелчок по надписи выглядел бы «мимо» и сразу закрывал список
    document.addEventListener('click', e => { if (msOpen && !e.composedPath().includes($(msOpen))) msClose(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') msClose(); });
    $('reset').addEventListener('click', () => {
      const keep = { beta: st.beta, betaPlaces: st.betaPlaces, minw: st.minw, gran: st.gran };
      st = Object.assign({}, DEFAULTS, keep, { follow: true, len: DEFAULTS.days, from: null, to: null, mode: '', project: A.noFilter(), product: A.noFilter() });
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
    $('place-clear').addEventListener('click', () => { st.place = ''; save(); graphs(); });
    // «Насколько раньше и позже»: вид и строки «штрихов»
    document.querySelectorAll('#an-margin-view button').forEach(b => b.addEventListener('click', () => { st.marginView = b.dataset.v; save(); render(); }));
    document.querySelectorAll('#an-margin-rows button').forEach(b => b.addEventListener('click', () => { st.marginRows = b.dataset.r; save(); render(); }));
    document.querySelectorAll('#an-sankey-mode button').forEach(b => b.addEventListener('click', () => { st.sankeyMode = b.dataset.m; save(); render(); }));
    // «Сегодня»: «к этому часу» сдвигается со временем — перерисовка раз в минуту, пока вкладка на виду
    setInterval(() => { if (visible && st.mode === 'today' && M && document.visibilityState === 'visible') render(); }, 60000);
    let rt;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (visible) render(); else dirty = true; }, 150); });
  }

  // --- отрисовка ------------------------------------------------------------
  const filtered = () => M.tasks.filter(t => A.inRange(t, st.from, st.to) && A.byDims(st)(t));

  function status(day) {
    const s = A.statusAt(M, day || st.from, day || st.to);
    const parts = [day ? `Сегодня, ${dmy(day)}` : `${dmy(st.from)} — ${dmy(st.to)}`];
    if (A.isOn(st.project)) parts.push((st.project.mode === 'out' ? 'проекты кроме: ' : '') + st.project.items.join(', '));
    if (A.isOn(st.product)) parts.push((st.product.mode === 'out' ? 'виды кроме: ' : '') + st.product.items.map(productName).join(', '));
    $('period').textContent = parts.join(' · ');
    // свежесть: последние 3 дня сверяются каждые 15 минут, более ранние (до 14 дней) — ночью
    $('status').innerHTML = s
      ? `статусы на <b>${dmhm(s.oldest)}</b>` + (s.newest.slice(0, 13) !== s.oldest.slice(0, 13) ? ` — ${dmhm(s.newest)}` : '')
      : 'статусы: нет данных';
    $('status').title = 'Задачи последних 3 дней сверяются с Bitrix при каждом запуске сборщика (раз в 15 минут), ' +
      'более ранние — раз в сутки после 04:00 на глубину 14 дней. В подсказке «Заказы по дням» — время сверки каждого дня.';
  }

  function loadScript(url, name) {
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = url; s.onload = ok; s.onerror = () => fail(new Error(name + ' не загрузился'));
      document.head.appendChild(s);
    });
  }
  // Observable Plot — только для «Штрихов»; после d3
  // d3-sankey — только для «От регистрации к крайнему сроку»; строго после d3 (иначе d3 затрёт его)
  function ensureSankey() {
    if (root.d3 && root.d3.sankey) return Promise.resolve();
    if (!sankeyWait) sankeyWait = ensureD3().then(() => loadScript(SANKEY_URL, 'd3-sankey'));
    return sankeyWait;
  }
  function ensurePlot() {
    if (root.Plot) return Promise.resolve();
    if (!plotWait) plotWait = ensureD3().then(() => loadScript(PLOT_URL, 'Observable Plot'));
    return plotWait;
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
    // цвет — пять стран с наибольшим числом упоминаний (место × заказ) в окне, остальные серые;
    // «акватории» (вода без страны) и «—» (место без страны) — не страны: в топ не входят;
    // у них свои цвета, отличные от серых «других стран»
    const NOT_COUNTRY = { 'акватории': ['var(--an-water)', 'акватории'], '—': ['var(--an-nocountry)', 'без страны'] };
    const named = groups.filter(k => !NOT_COUNTRY[k]).slice(0, SLOTS.length);
    const of = k => NOT_COUNTRY[k] ? NOT_COUNTRY[k][0] : named.includes(k) ? SLOTS[named.indexOf(k)] : 'var(--an-other)';
    const extra = groups.filter(k => NOT_COUNTRY[k]);
    const others = groups.length - named.length - extra.length;
    const item = (color, label) => `<span><span class="sw round" style="background:${color}"></span>${esc(label)}</span>`;
    return { of, legend: named.map(k => item(of(k), k)).join('') +
      (others ? item('var(--an-other)', `другие страны (${others})`) : '') + extra.map(k => item(...NOT_COUNTRY[k])).join('') };
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
    const rp = A.bundling.draw($('people-graph'), gp, { beta: st.beta, minw: st.minw.people, pin: st.person, onPin: id => update({ person: id }), color: peopleColors, linkedOnly: true, partnersOnly: true,
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
      pin: st.place, onPin: id => { st.place = id; save(); graphs(); },
      legend: $('places-legend'), table: $('places-table'), title: 'Какие места упоминаются вместе' });
    slider('places', rl.maxW);
    // закреплённое место может не попасть в окно — подсветка вернётся, когда окно до него дойдёт
    const place = st.place && M.places[st.place];
    $('place-pin').hidden = !place;
    $('place-name').textContent = place ? place.name + (rl.pinned ? '' : ' — нет в этом окне') : '';
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

  function marginControls() {
    const ticks = st.marginView === 'ticks';
    document.querySelectorAll('#an-margin-view button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === st.marginView)));
    document.querySelectorAll('#an-margin-rows button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.r === st.marginRows)));
    document.querySelectorAll('#an-sankey-mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === st.sankeyMode)));
    $('margin-rows').hidden = !ticks;
    $('margin-legend-bars').hidden = ticks;
    $('margin-legend-ticks').hidden = !ticks;
  }

  function render() {
    if (!M) return;
    // скрыта (или ещё нулевой ширины) — нарисуем при показе: иначе графики возьмут минимальную ширину
    // разделы режима — до проверки ширины: она смотрит на KPI того раздела, который сейчас покажем
    const today = st.mode === 'today';
    ['flow', 'terms', 'people', 'geo'].forEach(k => { document.getElementById('an-s-' + k).hidden = today; });
    $('s-today').hidden = !today;
    $('nav').hidden = today;
    if (!visible || !$(today ? 't-kpis' : 'kpis').offsetWidth) { dirty = true; return; }
    dirty = false;
    if (today) {
      // «сейчас» — часы браузера: данные приходят каждые 15 минут, файл переписывается только при изменениях
      const T = A.today(M, new Date(), A.byDims(st));
      status(T.day);
      D.todayView({ M, st, T, $, update, roleColor });
      return;
    }
    const setGran = g => { st.gran = g; save(); D.days(ctx); };
    const ctx = { M, st, list: filtered(), $, update, roleColor, setGran, loadPlot: ensurePlot, loadSankey: ensureSankey };
    marginControls();
    status();
    D.kpis(ctx); D.days(ctx); D.projects(ctx); D.heat(ctx);
    D.lead(ctx); D.sla(ctx); D.margin(ctx); A.sankey.render(ctx);
    D.execs(ctx); D.checks?.(ctx); D.geo(ctx);
    graphs();
  }

  // --- снаружи --------------------------------------------------------------
  // высота липкой панели фильтров (--an-top) — для «← Лента» и липкой панели графа мест; на телефоне панель
  // не липнет — 0. Следим за размером панели: переносы фильтров, смена ширины, первый показ вкладки.
  // (раньше считалась только в graphs() после загрузки d3 — до этого и в режиме «Сегодня» «← Лента» наезжала на панель)
  function setTop() {
    const bar = document.querySelector('.an-bar');
    if (bar) bar.parentElement.style.setProperty('--an-top', (getComputedStyle(bar).position === 'sticky' ? bar.offsetHeight : 0) + 'px');
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    const bar = document.querySelector('.an-bar');
    if (bar && root.ResizeObserver) new ResizeObserver(setTop).observe(bar);
    setTop();
    st = load();
    // закэшированная страница могла остаться с кнопкой hidden (пробный период) — показываем
    const tb = document.querySelector('#an-presets button[data-days="today"]');
    if (tb) tb.hidden = false;
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
