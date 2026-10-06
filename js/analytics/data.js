/*
 * Вкладка «Аналитика»: модель данных и общие помощники.
 * Вход — объект analytics.json (сборщик: tools/collector/analytics.py): days, people, places, tasks.
 * Здесь же — фильтры, подсчёты и графы связей; рисование — в dashboard.js и bundling.js.
 */
(function (root) {
  'use strict';

  const HOUR = 3600000, DAY = 86400000;
  const PRODUCTS = [
    { key: 'plasma', label: 'Плазма', color: 'var(--an-s1)', test: p => /^Плазма/.test(p) },
    { key: 'map', label: 'Анимированная карта', color: 'var(--an-s2)', test: p => p === 'Анимированная карта' },
    { key: 'clip', label: 'Overmap\\Overglobe', color: 'var(--an-s3)', test: p => /^Анимационный ролик/.test(p) },
    { key: 'other', label: 'Другое', color: 'var(--an-other)', test: () => true },
  ];
  const productKey = p => PRODUCTS.find(x => x.test(p)).key;
  // выполненным считается и «На рассмотрении»: исполнитель сдал работу, дата завершения уже есть
  // (если вернут на доработку — заказ выпадет из «Сроков» до повторной сдачи)
  const DONE = ['Завершена', 'На рассмотрении'];

  // --- даты и формат --------------------------------------------------------
  const nf = new Intl.NumberFormat('ru-RU');
  const fmtN = n => nf.format(n);
  const fmt1 = n => (Math.round(n * 10) / 10).toLocaleString('ru-RU');
  const fmtPct = x => x == null ? '—' : Math.round(x * 100) + '%';
  const fmtH = h => h == null ? '—' : h < 1 ? Math.round(h * 60) + ' мин' : h >= 48 ? fmt1(h / 24) + ' сут' : fmt1(h) + ' ч';
  const plural = (n, f) => f[n % 10 === 1 && n % 100 !== 11 ? 0 : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2];
  const dm = s => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  const dmy = s => `${dm(s)}.${s.slice(0, 4)}`;
  const dmhm = s => s ? `${dm(s)} ${s.slice(11, 16)}` : '—';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const addDays = (s, k) => { const d = new Date(s + 'T12:00'); d.setDate(d.getDate() + k); return d.toISOString().slice(0, 10); };
  const span = (a, b) => Math.round((new Date(b + 'T12:00') - new Date(a + 'T12:00')) / DAY) + 1;
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const countBy = (list, f) => { const m = new Map(); list.forEach(t => [].concat(f(t)).forEach(k => { if (k) m.set(k, (m.get(k) || 0) + 1); })); return m; };

  // --- модель ---------------------------------------------------------------
  // место → (страна, регион) для иерархии «Связей»; у стран — «страна целиком»
  function placeGroup(p) {
    if (p.kind === 'country') return { country: p.country || p.name, region: 'страна целиком' };
    return { country: p.country || (p.kind === 'water' ? 'акватории' : '—'), region: p.region || 'без региона' };
  }

  function prepare(payload) {
    // копии: исходные данные не трогаем (повторная подготовка тех же данных даёт тот же результат)
    const places = Object.fromEntries(Object.entries(payload.places || {}).map(([id, p]) =>
      [id, Object.assign({}, p, placeGroup(p), { area: p.region || p.country || '' })]));
    const tasks = payload.tasks.map(t => {
      const start = t.start ? new Date(t.start) : null, finish = t.finish ? new Date(t.finish) : null;
      const deadline = t.deadline ? new Date(t.deadline) : null;
      const done = DONE.includes(t.status) && finish;
      const pids = (t.places || []).filter(id => places[id]);
      return Object.assign({}, t, {
        startD: start, finishD: finish, deadlineD: deadline, pkey: productKey(t.product),
        lead: done && start ? (finish - start) / HOUR : null,
        onTime: done && deadline ? finish <= deadline : null,
        pids,
        // регионы для «Темы и регионы» — по координатам мест (у стран и вне регионов — страна)
        areas: t.an ? [...new Set(pids.map(id => places[id].area).filter(Boolean))] : null,
      });
    });
    const days = Object.keys(payload.days || {}).sort();
    if (!days.length) tasks.forEach(t => days.includes(t.day) || days.push(t.day));
    days.sort();
    return { tasks, places, people: payload.people || {}, checked: payload.days || {}, generatedAt: payload.generatedAt,
             firstDay: days[0], lastDay: days[days.length - 1] };
  }

  // --- фильтры --------------------------------------------------------------
  const inRange = (t, a, b) => t.day >= a && t.day <= b;
  const byDims = st => t => (!st.project || t.project === st.project) && (!st.product || t.pkey === st.product);

  // окно графа топонимов: 7 дней, конец — в пределах общего периода (по умолчанию его последний день)
  const WIN = 7;
  function topWindow(st) {
    const lo = addDays(st.from, WIN - 1) < st.to ? addDays(st.from, WIN - 1) : st.to;
    let end = st.winEnd || st.to;
    if (end > st.to) end = st.to;
    if (end < lo) end = lo;
    return { from: addDays(end, 1 - WIN), to: end, min: lo, max: st.to };
  }

  // «статусы на …»: самая ранняя сверка с Bitrix среди дней периода (ночная проверка — раз в сутки)
  function statusAt(model, from, to) {
    const ts = Object.entries(model.checked).filter(([d]) => d >= from && d <= to).map(([, at]) => at).filter(Boolean).sort();
    return ts.length ? { oldest: ts[0], newest: ts[ts.length - 1] } : null;
  }

  // --- графы связей ---------------------------------------------------------
  // пары узлов, встречающихся в одном заказе: [{a, b, w}]
  function pairs(lists) {
    const w = new Map();
    lists.forEach(items => {
      const ks = [...new Set(items)].sort();
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
        const k = ks[i] + '\u0002' + ks[j]; w.set(k, (w.get(k) || 0) + 1);
      }
    });
    return [...w.entries()].map(([k, v]) => { const [a, b] = k.split('\u0002'); return { a, b, w: v }; });
  }

  function graphPeople(model, list) {
    const n = countBy(list, t => t.workers);
    return {
      leaves: [...n.entries()].map(([name, k]) => ({ id: name, label: name, group: model.people[name] || 'Дизайнер', sub: null, n: k })),
      edges: pairs(list.map(t => t.workers)), groupWord: 'Профиль', nested: false,
    };
  }

  function graphPlaces(model, list) {
    const n = countBy(list, t => t.pids);
    return {
      leaves: [...n.entries()].map(([id, k]) => {
        const p = model.places[id];
        return { id, label: p.name, group: p.country, sub: p.region, note: p.region, n: k };
      }),
      edges: pairs(list.map(t => t.pids)), groupWord: 'Страна', nested: true,
    };
  }

  root.GanttAnalytics = Object.assign(root.GanttAnalytics || {}, {
    HOUR, DAY, PRODUCTS, WIN,
    prepare, placeGroup, inRange, byDims, topWindow, statusAt, pairs, graphPeople, graphPlaces,
    util: { fmtN, fmt1, fmtPct, fmtH, plural, dm, dmy, dmhm, esc, addDays, span, median, countBy },
  });
})(typeof window !== 'undefined' ? window : globalThis);
