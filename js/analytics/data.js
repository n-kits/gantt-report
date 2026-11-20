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
  // (если вернут на доработку — заказ выпадет из «Сроков» до повторной сдачи).
  // «Ожидающая» с датой завершения — тоже сдана: работу сдали, заказ потом отложили (20.11.2026)
  const DONE = ['Завершена', 'На рассмотрении', 'Ожидающая'];

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
  // wf — вес элемента (для заказов — кратность продукции: A.util.W); без него каждый элемент — 1
  const countBy = (list, f, wf) => { const m = new Map(); list.forEach(t => { const w = wf ? wf(t) : 1; [].concat(f(t)).forEach(k => { if (k) m.set(k, (m.get(k) || 0) + w); }); }); return m; };
  // кратность продукции: заказ «×2» — две единицы во всех объёмах (сколько заказов, нагрузка, «в работе»);
  // время выполнения и сроки — по заказу один раз (сдан один раз и в один срок)
  const W = t => t.w || 1;
  const sumW = list => list.reduce((a, t) => a + W(t), 0);

  // --- единицы продукции -------------------------------------------------------
  // Головная задача и её подзадачи — одна единица продукции (обычно подзадача — картографу, голова — дизайнеру).
  // Склеиваем здесь, а не в сборщике: архив и analytics.json хранят задачи как в Bitrix.
  // Вид продукции единицы — по приоритету (решение пользователя, 20.11.2026): ролик (Overmap / Overglobe) →
  // анимированная карта → стандартная карта → остальное (Растр 2D, Плазма…); при равенстве — вид головы.
  // Кратность — головы (разные кратности в паре — редкость, разбирается вручную).
  const stripMult = p => String(p || '').replace(/\s*\[\d+\]\s*$/, '').trim() || '—';   // «Плазма [2]» → «Плазма»
  const productRank = p => /^Анимационный ролик/.test(p) ? 0 : p === 'Анимированная карта' ? 1 : p === 'Стандартная карта' ? 2 : 3;
  function units(raw) {
    const byId = new Map(raw.map(t => [t.id, t]));
    const isHead = t => !t.parent || !byId.has(t.parent) || byId.get(t.parent).parent || t.parent === t.id;
    const subs = new Map();
    raw.forEach(t => { if (!isHead(t)) { if (!subs.has(t.parent)) subs.set(t.parent, []); subs.get(t.parent).push(t); } });
    return raw.filter(isHead).map(h => {
      const kids = subs.get(h.id) || [], parts = [h, ...kids];
      const product = parts.map((p, i) => ({ p: stripMult(p.product), i }))
        .sort((a, b) => productRank(a.p) - productRank(b.p) || a.i - b.i)[0].p;
      const starts = parts.map(p => p.start).filter(Boolean).sort();
      const places = [...new Set(parts.flatMap(p => p.places || []))];
      const ans = parts.map(p => p.an).filter(Boolean);
      return Object.assign({}, h, {
        product, start: starts[0] || h.start,
        workers: [...new Set(parts.flatMap(p => p.workers || []))].sort(),
        places: places.length ? places : undefined,
        an: ans.length ? { themes: [...new Set(ans.flatMap(a => a.themes || []))], conflict: (ans.find(a => a.conflict) || ans[0]).conflict || '' } : null,
        checkers: [...new Set(parts.map(p => p.checker).filter(Boolean))],
        ex: parts.some(p => p.ex),
        w: h.k > 1 ? h.k : 1,
        subs: kids.map(s => ({ id: s.id, status: s.status, start: s.start, finish: s.finish, deadline: s.deadline, workers: s.workers || [], k: s.k || 1 })),
        orphan: !!(h.parent && !byId.has(h.parent)),   // подзадача, чья голова не попала в выборку Bitrix
      });
    });
  }

  // «Фамилия И. О.» / «Фамилия И.» → «Фамилия И» — так сравниваем проверяющего с исполнителями
  const personKey = s => { const p = String(s || '').replace(/\./g, ' ').split(/\s+/).filter(Boolean); return p.length ? p[0] + ' ' + (p[1] || '').charAt(0) : ''; };
  // проверка финальной графики: ok — есть проверяющий не из исполнителей или проверял участник совместного заказа
  // с другим картографом; self — проверил сам себя; none — проверяющего нет
  function checkOf(t, people) {
    if (!t.checkers.length) return 'none';
    const ws = t.workers.map(w => ({ w, k: personKey(w) }));
    return t.checkers.some(c => {
      const ck = personKey(c);
      return !ws.some(x => x.k === ck) || ws.some(x => x.k !== ck && people[x.w] === 'Картограф');
    }) ? 'ok' : 'self';
  }

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
    const people = payload.people || {};
    // проверяющий «Фамилия И.» → имя из «Выполнения задачи» («Фамилия И. О.»), если такое одно
    const byKey = new Map();
    Object.keys(people).forEach(n => { const k = personKey(n); byKey.set(k, byKey.has(k) ? null : n); });
    const fullName = c => byKey.get(personKey(c)) || c;
    const tasks = units(payload.tasks).map(t => {
      const start = t.start ? new Date(t.start) : null, finish = t.finish ? new Date(t.finish) : null;
      const deadline = t.deadline ? new Date(t.deadline) : null;
      const done = DONE.includes(t.status) && finish;
      const pids = (t.places || []).filter(id => places[id]);
      return Object.assign({}, t, {
        startD: start, finishD: finish, deadlineD: deadline, pkey: productKey(t.product),
        lead: done && start ? (finish - start) / HOUR : null,
        onTime: done && deadline ? finish <= deadline : null,
        done: !!done, check: checkOf(t, people), checkers: t.checkers.map(fullName),
        pids,
        // регионы для «Темы и регионы» — по координатам мест (у стран и вне регионов — страна)
        areas: t.an ? [...new Set(pids.map(id => places[id].area).filter(Boolean))] : null,
      });
    });
    const days = Object.keys(payload.days || {}).sort();
    if (!days.length) tasks.forEach(t => days.includes(t.day) || days.push(t.day));
    days.sort();
    return { tasks, places, people, checked: payload.days || {}, generatedAt: payload.generatedAt,
             firstDay: days[0], lastDay: days[days.length - 1] };
  }

  // --- фильтры --------------------------------------------------------------
  const inRange = (t, a, b) => t.day >= a && t.day <= b;
  // фильтр проекта / вида продукции: { mode: 'in' — только выбранные | 'out' — все, кроме, items: [...] }; пустой — все
  const noFilter = () => ({ mode: 'in', items: [] });
  const isOn = f => !!(f && f.items && f.items.length);
  const passes = (f, v) => !isOn(f) || (f.mode === 'out' ? !f.items.includes(v) : f.items.includes(v));
  // клик по графику: «только этот» (повторный — снять); с Ctrl — добавить к выбору / убрать из него
  function toggleItem(f, key, add) {
    f = isOn(f) ? f : noFilter();
    if (!add) return f.mode === 'in' && f.items.length === 1 && f.items[0] === key ? noFilter() : { mode: 'in', items: [key] };
    const items = f.items.includes(key) ? f.items.filter(k => k !== key) : [...f.items, key];
    return { mode: f.mode, items };
  }
  // подпись: «Погода (Р24)», «Погода (Р24) +2», «кроме: Погода (Р24)»; '' — фильтра нет
  function filterLabel(f, name) {
    if (!isOn(f)) return '';
    const s = name(f.items[0]) + (f.items.length > 1 ? ` +${f.items.length - 1}` : '');
    return f.mode === 'out' ? `кроме: ${s}` : s;
  }
  // сохранённое до 11.2026 значение — строка с одним проектом / видом
  const asFilter = v => typeof v === 'string' ? (v ? { mode: 'in', items: [v] } : noFilter())
    : v && Array.isArray(v.items) ? { mode: v.mode === 'out' ? 'out' : 'in', items: v.items.slice() } : noFilter();
  const byDims = st => t => passes(st.project, t.project) && passes(st.product, t.pkey);

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
  // когда заказ сдан: «Завершена» / «На рассмотрении» / «Ожидающая» с датой завершения; «Выполняется» с датой — вернули, ещё идёт
  const doneAt = t => DONE.includes(t.status) && t.finishD ? t.finishD : null;

  // в работе в момент T: зарегистрирован (не раньше OPEN_MAX_DAYS) и ещё не сдан
  function openAt(list, T) {
    const lo = T.getTime() - OPEN_MAX_DAYS * DAY;
    let open = 0;
    for (const t of list) {
      if (!t.startD || t.startD > T || t.startD.getTime() < lo) continue;
      const e = doneAt(t);
      if (e && e <= T) continue;
      open += W(t);
    }
    return { open };
  }

  // просрочено сегодня к моменту T: крайний срок — в рабочих сутках d (с 04:00) и уже прошёл, а к сроку не сдан
  // (сдан позже или ещё не сдан; сданный с опозданием из счёта не выпадает). open — из них не сдано к T
  function lateOn(list, d, T) {
    const from = dayStart(d);
    let late = 0, open = 0;
    for (const t of list) {
      if (!t.deadlineD || t.deadlineD < from || t.deadlineD >= T) continue;
      const e = doneAt(t);
      if (e && e <= t.deadlineD) continue;
      late += W(t);
      if (!e || e > T) open += W(t);
    }
    return { late, open };
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
    const arrivedCurve = curve((d, hh) => sumW(arrived(d, hh)));
    const openCurve = curve((d, hh) => openAt(list, at(d, hh)).open);

    const nowT = arrived(day, h);
    const cur = openAt(list, now), curLate = lateOn(list, day, now);
    const refOpen = refs.map(d => openAt(list, at(d, h)));
    const refLate = refs.map(d => lateOn(list, d, at(d, h)));

    // разрезы «к этому часу»: сегодня и медиана тех же дней недели
    const slice = key => {
      const t = countBy(nowT, key, W), r = refs.map(d => countBy(arrived(d, h), key, W));
      const keys = new Set([...t.keys(), ...r.flatMap(m => [...m.keys()])]);
      return [...keys].map(k => ({ key: k, value: t.get(k) || 0, ref: quantile(r.map(m => m.get(k) || 0), 0.5) || 0 }))
        .filter(x => x.value || x.ref >= 0.5)
        .sort((a, b) => b.value - a.value || b.ref - a.ref);
    };

    // места и темы дня против «в среднем в день» за PLACE_REF_DAYS дней до сегодня (любые дни недели)
    const placeFrom = addDays(day, -PLACE_REF_DAYS);
    const placeDays = Math.max(1, Math.min(PLACE_REF_DAYS, span(model.firstDay > placeFrom ? model.firstDay : placeFrom, addDays(day, -1))));
    const pastList = list.filter(t => t.day >= placeFrom && t.day < day);
    const vsPast = (key, label) => {
      const past = countBy(pastList, key);
      return [...countBy(nowT, key).entries()].map(([k, v]) => {
        const n = past.get(k) || 0;
        return Object.assign({ key: k, value: v, ref: n / placeDays, isNew: !n }, label(k));
      }).sort((a, b) => b.value - a.value || a.ref - b.ref);
    };
    const places = vsPast(t => t.pids, id => ({ label: model.places[id].name, area: model.places[id].area }));
    // темы — фиксированный список (geo.THEMES), поэтому день честно сравним с обычным; только заказы с анализом
    const themes = vsPast(t => t.an ? t.an.themes : [], k => ({ label: k }));

    // исполнители: нагрузка смены к этому часу против того же дня недели. Исполнители (workers) — из «Выполнения
    // задачи», заполнены у взятых в работу заказов. «Ещё не взяты» — нет отметок в «Выполнении задачи»
    // и не назначен «Исполнитель» (ex; в старых данных признака нет — тогда только по отметкам)
    // заказов на человека — по участиям: совместный заказ засчитывается каждому участнику целиком (как в списке
    // «кто сколько взял»); иначе в дни передач и совместной работы показатель проседал бы при росте нагрузки.
    // joint — доля совместных (2+ исполнителя) среди взятых
    const crew = ts => {
      const taken = ts.filter(t => t.workers && t.workers.length), people = new Set(taken.flatMap(t => t.workers));
      const touches = taken.reduce((a, t) => a + new Set(t.workers).size * W(t), 0), n = sumW(taken);
      return { people: people.size, taken: n, perPerson: people.size ? touches / people.size : null,
               joint: n ? sumW(taken.filter(t => new Set(t.workers).size > 1)) / n : null };
    };
    const crewNow = crew(nowT), crewRef = refs.map(d => crew(arrived(d, h)));
    // у кого сейчас в работе (не сдано) — по тем же правилам, что «В работе сейчас»
    const busy = new Map();
    list.forEach(t => {
      if (!t.startD || t.startD > now || t.startD.getTime() < now.getTime() - OPEN_MAX_DAYS * DAY) return;
      const e = doneAt(t);
      if (e && e <= now) return;
      (t.workers || []).forEach(w => busy.set(w, (busy.get(w) || 0) + W(t)));
    });
    const takenToday = countBy(nowT, t => t.workers || [], W);
    const workers = [...new Set([...takenToday.keys(), ...busy.keys()])].map(w => ({
      key: w, label: w, role: model.people[w] || 'Дизайнер', value: takenToday.get(w) || 0, busy: busy.get(w) || 0,
    })).sort((a, b) => b.value - a.value || b.busy - a.busy || a.label.localeCompare(b.label, 'ru'));

    return {
      day, now, h, refs, refWord: WEEKDAY_DAT[dayStart(day).getDay()], placeDays,
      arrived: Object.assign({ today: sumW(nowT) }, spread(refs.map(d => sumW(arrived(d, h))))),
      fullDay: spread(refs.map(d => sumW(byDay.get(d) || []))),
      open: Object.assign({ today: cur.open }, spread(refOpen.map(x => x.open))),
      late: Object.assign({ today: curLate.late, open: curLate.open }, spread(refLate.map(x => x.late))),
      analyzed: nowT.filter(t => t.an).length,
      curves: { arrived: arrivedCurve, open: openCurve },
      products: slice(t => t.pkey), projects: slice(t => t.project), places, themes,
      crew: { people: Object.assign({ today: crewNow.people }, spread(crewRef.map(x => x.people))),
              perPerson: Object.assign({ today: crewNow.perPerson }, spread(crewRef.map(x => x.perPerson).filter(v => v != null))),
              joint: Object.assign({ today: crewNow.joint }, spread(crewRef.map(x => x.joint).filter(v => v != null))),
              notTaken: sumW(nowT.filter(t => !(t.workers && t.workers.length) && !t.ex)) },
      workers,
    };
  }

  // --- графы связей ---------------------------------------------------------
  // пары узлов, встречающихся в одном заказе: [{a, b, w}]
  // weights — вес каждого заказа (кратность), без него — 1
  function pairs(lists, weights) {
    const w = new Map();
    lists.forEach((items, li) => {
      const ks = [...new Set(items)].sort(), wt = weights ? weights[li] : 1;
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
        const k = ks[i] + '\u0002' + ks[j]; w.set(k, (w.get(k) || 0) + wt);
      }
    });
    return [...w.entries()].map(([k, v]) => { const [a, b] = k.split('\u0002'); return { a, b, w: v }; });
  }

  function graphPeople(model, list) {
    const n = countBy(list, t => t.workers, W);
    return {
      leaves: [...n.entries()].map(([name, k]) => ({ id: name, label: name, group: model.people[name] || 'Дизайнер', sub: null, n: k })),
      edges: pairs(list.map(t => t.workers), list.map(W)), groupWord: 'Профиль', nested: false,
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
    noFilter, isOn, passes, toggleItem, filterLabel, asFilter,
    today, openAt, workdayOf, DAY_START, REF_WEEKS,
    buckets, autoGran, bucketLabel, GRANS, MONTHS,
    units, stripMult, productRank, personKey, checkOf,
    util: { fmtN, fmt1, fmtPct, fmtH, plural, dm, dmy, dmhm, esc, addDays, span, median, countBy, quantile, W, sumW },
  });
})(typeof window !== 'undefined' ? window : globalThis);
