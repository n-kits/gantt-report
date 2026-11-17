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

  // --- укрупнение «Заказов по дням»: дни → недели (пн–вс) → месяцы ----------------
  // Столбик периода: key — первый день календарного периода, days — его дни внутри [from, to],
  // full — сколько дней в периоде целиком; partial — период обрезан краем выбранного интервала.
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const GRANS = ['day', 'week', 'month'];
  function periodStart(d, gran) {
    if (gran === 'week') return addDays(d, -((new Date(d + 'T12:00').getDay() + 6) % 7));
    if (gran === 'month') return d.slice(0, 8) + '01';
    return d;
  }
  function periodLen(key, gran) {
    if (gran === 'week') return 7;
    if (gran === 'month') return new Date(+key.slice(0, 4), +key.slice(5, 7), 0).getDate();
    return 1;
  }
  function buckets(from, to, gran) {
    const out = [], by = new Map();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const k = periodStart(d, gran);
      if (!by.has(k)) { const b = { key: k, gran, days: [], full: periodLen(k, gran) }; by.set(k, b); out.push(b); }
      by.get(k).days.push(d);
    }
    out.forEach(b => { b.partial = b.days.length < b.full; });
    return out;
  }
  // самый мелкий шаг, при котором столбик не уже minBand пикселей
  function autoGran(from, to, width, minBand) {
    return GRANS.find(g => width / buckets(from, to, g).length >= minBand) || 'month';
  }
  const bucketLabel = b => b.gran === 'month' ? `${MONTHS[+b.key.slice(5, 7) - 1]} ${b.key.slice(2, 4)}` : dm(b.key);

  // --- «Сегодня»: день против обычного такого же дня недели --------------------
  // Рабочие сутки — с 04:00. «Обычный» — тот же день недели за REF_WEEKS прошлых недель (поток сильно зависит
  // от дня недели: в понедельник ~23 заказа, в субботу ~2), сравнение — к тому же часу суток.
  const DAY_START = 4, REF_WEEKS = 8, OPEN_MAX_DAYS = 30, PLACE_REF_DAYS = 28;
  const WEEKDAY_DAT = ['воскресеньям', 'понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам'];
  const pad2 = n => String(n).padStart(2, '0');
  const isoDay = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const workdayOf = d => isoDay(new Date(d.getTime() - DAY_START * HOUR));
  const dayStart = s => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), DAY_START);
  // квантиль с интерполяцией (q = 0.5 — медиана)
  function quantile(a, q) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), p = (s.length - 1) * q, i = Math.floor(p);
    return s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (p - i);
  }
  const spread = a => ({ med: quantile(a, 0.5), lo: quantile(a, 0.25), hi: quantile(a, 0.75), n: a.length });
  // когда заказ сдан: «Завершена» / «На рассмотрении» с датой завершения; «Выполняется» с датой — вернули, ещё идёт
  const doneAt = t => DONE.includes(t.status) && t.finishD ? t.finishD : null;

  // в работе в момент T: зарегистрирован (не раньше OPEN_MAX_DAYS) и ещё не сдан; просрочен — крайний срок прошёл
  function openAt(list, T) {
    const lo = T.getTime() - OPEN_MAX_DAYS * DAY;
    let open = 0, late = 0;
    for (const t of list) {
      if (!t.startD || t.startD > T || t.startD.getTime() < lo) continue;
      const e = doneAt(t);
      if (e && e <= T) continue;
      open++;
      if (t.deadlineD && t.deadlineD < T) late++;
    }
    return { open, late };
  }

  function today(model, now, dims) {
    const list = dims ? model.tasks.filter(dims) : model.tasks;
    const day = workdayOf(now), base = dayStart(day);
    const h = Math.max(0, Math.min(24, (now - base) / HOUR));
    const refs = [];
    for (let k = 1; k <= REF_WEEKS; k++) { const d = addDays(day, -7 * k); if (d >= model.firstDay) refs.push(d); }
    const byDay = new Map();
    list.forEach(t => { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day).push(t); });
    const at = (d, hh) => new Date(dayStart(d).getTime() + hh * HOUR);
    const arrived = (d, hh) => { const T = at(d, hh); return (byDay.get(d) || []).filter(t => t.startD && t.startD < T); };

    // кривые по часам 0…24 от 04:00: сегодня — только до «сейчас», последняя точка — сам момент «сейчас»
    const curve = f => {
      const out = [];
      for (let k = 0; k <= 24; k++) {
        const ref = spread(refs.map(d => f(d, k)));
        out.push(Object.assign({ k, today: k <= h ? f(day, k) : null }, ref));
      }
      if (h < 24 && h > Math.floor(h)) out.splice(Math.floor(h) + 1, 0, Object.assign({ k: h, today: f(day, h), now: true }, spread(refs.map(d => f(d, h)))));
      return out;
    };
    const arrivedCurve = curve((d, hh) => arrived(d, hh).length);
    const openCurve = curve((d, hh) => openAt(list, at(d, hh)).open);

    const nowT = arrived(day, h);
    const cur = openAt(list, now);
    const refOpen = refs.map(d => openAt(list, at(d, h)));

    // разрезы «к этому часу»: сегодня и медиана тех же дней недели
    const slice = key => {
      const t = countBy(nowT, key), r = refs.map(d => countBy(arrived(d, h), key));
      const keys = new Set([...t.keys(), ...r.flatMap(m => [...m.keys()])]);
      return [...keys].map(k => ({ key: k, value: t.get(k) || 0, ref: quantile(r.map(m => m.get(k) || 0), 0.5) || 0 }))
        .filter(x => x.value || x.ref >= 0.5)
        .sort((a, b) => b.value - a.value || b.ref - a.ref);
    };

    // места дня против «в среднем в день» за PLACE_REF_DAYS дней до сегодня (любые дни недели)
    const placeFrom = addDays(day, -PLACE_REF_DAYS);
    const placeDays = Math.max(1, Math.min(PLACE_REF_DAYS, span(model.firstDay > placeFrom ? model.firstDay : placeFrom, addDays(day, -1))));
    const past = countBy(list.filter(t => t.day >= placeFrom && t.day < day), t => t.pids);
    const places = [...countBy(nowT, t => t.pids).entries()].map(([id, v]) => {
      const p = model.places[id], n = past.get(id) || 0;
      return { key: id, label: p.name, area: p.area, value: v, ref: n / placeDays, isNew: !n };
    }).sort((a, b) => b.value - a.value || a.ref - b.ref);

    return {
      day, now, h, refs, refWord: WEEKDAY_DAT[dayStart(day).getDay()], placeDays,
      arrived: Object.assign({ today: nowT.length }, spread(refs.map(d => arrived(d, h).length))),
      fullDay: spread(refs.map(d => (byDay.get(d) || []).length)),
      open: Object.assign({ today: cur.open }, spread(refOpen.map(x => x.open))),
      late: Object.assign({ today: cur.late }, spread(refOpen.map(x => x.late))),
      analyzed: nowT.filter(t => t.an).length,
      curves: { arrived: arrivedCurve, open: openCurve },
      products: slice(t => t.pkey), projects: slice(t => t.project), places,
    };
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
    today, openAt, workdayOf, DAY_START, REF_WEEKS,
    buckets, autoGran, bucketLabel, GRANS, MONTHS,
    util: { fmtN, fmt1, fmtPct, fmtH, plural, dm, dmy, dmhm, esc, addDays, span, median, countBy, quantile },
  });
})(typeof window !== 'undefined' ? window : globalThis);
