/* Тесты вкладки «Аналитика» (js/analytics/data.js). Запуск: открыть tests/index.html в браузере. */
(function () {
  'use strict';
  const A = window.GanttAnalytics;
  const results = [];
  function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, err: e.message }); }
  }
  function eq(a, b, msg) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`${msg || ''} ожидалось ${sb}, получено ${sa}`);
  }

  const PAYLOAD = {
    v: 1, generatedAt: '2026-10-05T12:00',
    days: { '2026-10-01': '2026-10-05T04:01:00', '2026-10-02': '2026-10-05T04:01:00', '2026-10-05': '2026-10-05T11:46:00' },
    people: { 'Иванов И. И.': 'Картограф', 'Петрова П. П.': 'Дизайнер' },
    places: {
      'place:казань:RU-TA': { name: 'Казань', kind: 'settlement', country: 'Россия', region: 'Республика Татарстан' },
      'country:UKR': { name: 'Украина', kind: 'country', country: 'Украина', region: '' },
      'water:днепр': { name: 'Днепр (река)', kind: 'water', country: '', region: '' },
    },
    tasks: [
      { id: '1', day: '2026-10-01', status: 'Завершена', start: '2026-10-01T08:00', finish: '2026-10-01T09:00', deadline: '2026-10-01T10:00',
        project: 'Погода (Р24)', product: 'Плазма', workers: ['Иванов И. И.'], an: { themes: ['Погода'], conflict: '' },
        places: ['place:казань:RU-TA', 'country:UKR'] },
      { id: '2', day: '2026-10-02', status: 'Завершена', start: '2026-10-02T08:00', finish: '2026-10-02T12:00', deadline: '2026-10-02T10:00',
        project: 'Вести (Р24)', product: 'Анимационный ролик 3D', workers: ['Иванов И. И.', 'Петрова П. П.'], an: null },
      { id: '3', day: '2026-10-05', status: 'На рассмотрении', start: '2026-10-05T08:00', finish: '2026-10-05T08:30', deadline: '2026-10-05T09:00',
        project: 'Вести (Р24)', product: 'Анимированная карта', workers: ['Петрова П. П.'], an: { themes: [], conflict: 'да' },
        places: ['water:днепр', 'нет-такого'] },
    ],
  };

  test('аналитика: «Выполняется» не считается выполненным, даже с датой завершения', () => {
    const M = A.prepare(Object.assign({}, PAYLOAD, { tasks: [Object.assign({}, PAYLOAD.tasks[0], { status: 'Выполняется' })] }));
    eq([M.tasks[0].onTime, M.tasks[0].lead], [null, null]);
  });

  test('аналитика: подготовка модели — срок, время выполнения, вид продукции, регионы', () => {
    const M = A.prepare(PAYLOAD);
    eq([M.firstDay, M.lastDay], ['2026-10-01', '2026-10-05']);
    eq(M.tasks.map(t => t.onTime), [true, false, true], 'в срок — у «Завершена» и «На рассмотрении»');
    eq(M.tasks.map(t => t.lead), [1, 4, 0.5], 'часы от регистрации до завершения');
    eq(M.tasks.map(t => t.pkey), ['plasma', 'clip', 'map']);
    eq(M.tasks[0].areas, ['Республика Татарстан', 'Украина'], 'регион, у страны — страна');
    eq(M.tasks[1].areas, null, 'без анализа LLM — нет регионов');
    eq(M.tasks[2].pids, ['water:днепр'], 'неизвестное место отброшено');
    eq([M.places['country:UKR'].region, M.places['water:днепр'].country], ['страна целиком', 'акватории']);
  });

  test('аналитика: окно графа мест — 7 дней внутри периода', () => {
    const st = { from: '2026-09-01', to: '2026-09-30', winEnd: null };
    eq(A.topWindow(st), { from: '2026-09-24', to: '2026-09-30', min: '2026-09-07', max: '2026-09-30' }, 'по умолчанию — конец периода');
    eq(A.topWindow(Object.assign({}, st, { winEnd: '2026-09-02' })).to, '2026-09-07', 'не раньше 7-го дня периода');
    eq(A.topWindow(Object.assign({}, st, { winEnd: '2026-10-03' })).to, '2026-09-30', 'не позже конца периода');
    eq(A.topWindow({ from: '2026-09-28', to: '2026-09-30', winEnd: null }).from, '2026-09-24', 'период короче окна — окно шире');
  });

  test('аналитика: «статусы на» — самая ранняя сверка в периоде', () => {
    const M = A.prepare(PAYLOAD);
    eq(A.statusAt(M, '2026-10-01', '2026-10-05'), { oldest: '2026-10-05T04:01:00', newest: '2026-10-05T11:46:00' });
    eq(A.statusAt(M, '2026-09-01', '2026-09-30'), null);
  });

  test('аналитика: связи — пары в одном заказе, вес — число заказов', () => {
    eq(A.pairs([['б', 'а'], ['а', 'б', 'в'], ['в']]), [{ a: 'а', b: 'б', w: 2 }, { a: 'а', b: 'в', w: 1 }, { a: 'б', b: 'в', w: 1 }]);
    const M = A.prepare(PAYLOAD);
    const g = A.graphPeople(M, M.tasks);
    eq(g.leaves.map(l => [l.id, l.group, l.n]), [['Иванов И. И.', 'Картограф', 2], ['Петрова П. П.', 'Дизайнер', 2]]);
    eq(g.edges, [{ a: 'Иванов И. И.', b: 'Петрова П. П.', w: 1 }]);
    eq(A.graphPlaces(M, M.tasks).leaves.map(l => [l.label, l.group, l.sub]),
      [['Казань', 'Россия', 'Республика Татарстан'], ['Украина', 'Украина', 'страна целиком'], ['Днепр (река)', 'акватории', 'без региона']]);
  });

  test('«Сегодня»: к тому же часу против того же дня недели, рабочие сутки с 04:00', () => {
    const t = (id, day, start, status, finish, deadline, places) => ({ id, day, status, start, finish: finish || '', deadline: deadline || '',
      project: 'Вести (Р24)', product: 'Плазма', workers: [], an: places ? { themes: [], conflict: '' } : null, places: places || [] });
    const P = {
      v: 1, days: { '2026-10-06': '', '2026-10-12': '', '2026-10-13': '' },
      places: { 'place:казань:RU-TA': { name: 'Казань', kind: 'settlement', country: 'Россия', region: 'Республика Татарстан' } },
      tasks: [
        // прошлый вторник: 2 заказа до 12:00, 1 — после; один сдан в 11:00, другой — в 20:00 с нарушением срока (14:00)
        t('a', '2026-10-06', '2026-10-06T08:00', 'Завершена', '2026-10-06T11:00', '2026-10-06T12:00'),
        t('b', '2026-10-06', '2026-10-06T10:00', 'Завершена', '2026-10-06T20:00', '2026-10-06T14:00'),
        t('c', '2026-10-06', '2026-10-06T15:00', 'Завершена', '2026-10-06T16:00'),
        // понедельник в 23:00 — ещё «Выполняется», срок прошёл: сегодня в работе и просрочен
        t('m', '2026-10-12', '2026-10-12T23:00', 'Выполняется', '', '2026-10-13T09:00'),
        // сегодня: 03:30 следующей календарной даты — ещё сегодняшние рабочие сутки
        t('d', '2026-10-13', '2026-10-13T09:00', 'На рассмотрении', '2026-10-13T10:00', '', ['place:казань:RU-TA']),
        t('e', '2026-10-13', '2026-10-13T11:00', 'Выполняется', '2026-10-13T11:30'),
      ],
    };
    const M = A.prepare(P);
    const T = A.today(M, new Date(2026, 9, 13, 12, 0));
    eq([T.day, T.h, T.refs, T.refWord], ['2026-10-13', 8, ['2026-10-06'], 'вторникам']);
    eq([T.arrived.today, T.arrived.med, T.fullDay.med], [2, 2, 3], 'к 12:00 — 2 и 2, за прошлый вторник — 3');
    eq([T.open.today, T.late.today], [2, 1], '«Выполняется» с датой завершения — ещё в работе; m — просрочен');
    eq([T.open.med, T.late.med], [1, 0], 'прошлый вторник в 12:00: b в работе, срок ещё не прошёл');
    eq(T.curves.arrived.filter(p => p.k === 4 || p.k === 8).map(p => [p.today, p.med]), [[0, 0], [2, 2]]);
    eq(T.curves.arrived.find(p => p.k === 9).today, null, 'после «сейчас» — без сегодняшней линии');
    eq(T.places.map(p => [p.label, p.value, p.isNew]), [['Казань', 1, true]]);
    eq(T.themes, [], 'у заказов дня тем нет — пусто');
    eq([T.crew.people.today, T.crew.notTaken], [0, 2], 'в тесте исполнителей нет — оба заказа «ещё не взяты»');
    eq(A.today(M, new Date(2026, 9, 14, 3, 30)).day, '2026-10-13', 'до 04:00 — ещё вчерашние рабочие сутки');
  });

  test('«Сегодня»: темы против среднего за 4 недели, нагрузка смены, кто сколько взял', () => {
    const t = (id, day, start, status, finish, workers, themes) => ({ id, day, status, start, finish: finish || '', deadline: '',
      project: 'Вести (Р24)', product: 'Плазма', workers, an: themes ? { themes, conflict: '' } : null, places: [] });
    const P = { v: 1, days: { '2026-10-06': '', '2026-10-13': '' }, people: { 'Иванов И. И.': 'Картограф' }, places: {}, tasks: [
      // прошлый вторник к 12:00: 2 заказа у одного человека
      t('a', '2026-10-06', '2026-10-06T08:00', 'Завершена', '2026-10-06T09:00', ['Иванов И. И.'], ['Осадки']),
      t('b', '2026-10-06', '2026-10-06T09:00', 'Завершена', '2026-10-06T10:00', ['Иванов И. И.'], ['Осадки']),
      // сегодня: 3 заказа, двое людей, один заказ ещё не взят; одна тема новая; c — совместный (передача)
      t('c', '2026-10-13', '2026-10-13T08:00', 'Завершена', '2026-10-13T09:00', ['Иванов И. И.', 'Петрова П. П.'], ['Осадки', 'Землетрясение']),
      t('d', '2026-10-13', '2026-10-13T09:00', 'Выполняется', '', ['Петрова П. П.'], ['Осадки']),
      t('e', '2026-10-13', '2026-10-13T11:00', 'Зарегистрирована', '', [], null),
    ] };
    const T = A.today(A.prepare(P), new Date(2026, 9, 13, 12, 0));
    eq(T.themes.map(x => [x.label, x.value, x.isNew]), [['Осадки', 2, false], ['Землетрясение', 1, true]]);
    // участия: c — обоим, d — Петровой → 3 участия на 2 людей = 1,5 (по заказам было бы 2 / 2 = 1)
    eq([T.crew.people.today, T.crew.people.med, T.crew.perPerson.today, T.crew.perPerson.med, T.crew.notTaken], [2, 1, 1.5, 2, 1]);
    eq([T.crew.joint.today, T.crew.joint.med], [0.5, 0], 'совместных: 1 из 2 взятых; в прошлый вторник — 0');
    eq(T.workers.map(w => [w.label, w.role, w.value, w.busy]), [['Петрова П. П.', 'Дизайнер', 2, 1], ['Иванов И. И.', 'Картограф', 1, 0]],
      'взял сегодня / в работе сейчас (при равенстве выше тот, у кого больше в работе); без профиля — дизайнер');
  });

  test('«Заказы по дням»: укрупнение до недель (пн–вс) и месяцев, неполные периоды по краям', () => {
    const w = A.buckets('2026-09-03', '2026-09-21', 'week');   // чт … пн
    eq(w.map(b => [b.key, b.days.length, b.partial]), [['2026-08-31', 4, true], ['2026-09-07', 7, false], ['2026-09-14', 7, false], ['2026-09-21', 1, true]]);
    const m = A.buckets('2026-09-01', '2026-11-17', 'month');
    eq(m.map(b => [b.key, b.days.length, b.full, b.partial, A.bucketLabel(b)]),
      [['2026-09-01', 30, 30, false, 'сен 26'], ['2026-10-01', 31, 31, false, 'окт 26'], ['2026-11-01', 17, 30, true, 'ноя 26']]);
    eq(A.buckets('2026-11-16', '2026-11-17', 'day').map(b => [b.key, b.partial]), [['2026-11-16', false], ['2026-11-17', false]]);
    // 78 дней при 16 px на столбик: 1300 px — дни, 900 px — недели; год при 300 px — месяцы
    eq([A.autoGran('2026-09-01', '2026-11-17', 1300, 16), A.autoGran('2026-09-01', '2026-11-17', 900, 16),
        A.autoGran('2026-09-01', '2027-08-31', 300, 16)], ['day', 'week', 'month']);
  });

  test('фильтры «Проект» / «Вид продукции»: несколько, «все, кроме», клик по графику, старое значение', () => {
    const M = A.prepare(PAYLOAD);
    const ids = st => M.tasks.filter(A.byDims(st)).map(t => t.id);
    eq(ids({ project: A.noFilter(), product: A.noFilter() }), ['1', '2', '3'], 'пустой — все');
    eq(ids({ project: { mode: 'in', items: ['Вести (Р24)'] }, product: A.noFilter() }), ['2', '3']);
    eq(ids({ project: { mode: 'in', items: ['Вести (Р24)', 'Погода (Р24)'] }, product: A.noFilter() }), ['1', '2', '3'], 'несколько');
    eq(ids({ project: { mode: 'out', items: ['Вести (Р24)'] }, product: A.noFilter() }), ['1'], 'все, кроме');
    eq(ids({ project: { mode: 'out', items: ['Вести (Р24)'] }, product: { mode: 'out', items: ['plasma'] } }), [], 'оба фильтра вместе');
    eq(ids({ project: A.noFilter(), product: { mode: 'in', items: ['clip', 'map'] } }), ['2', '3']);
    // клик: «только этот», повторный — снять; Ctrl — добавить/убрать, режим сохраняется
    const one = A.toggleItem(A.noFilter(), 'a', false);
    eq([one, A.toggleItem(one, 'a', false)], [{ mode: 'in', items: ['a'] }, { mode: 'in', items: [] }]);
    eq(A.toggleItem({ mode: 'out', items: ['a'] }, 'b', true), { mode: 'out', items: ['a', 'b'] });
    eq(A.toggleItem({ mode: 'out', items: ['a', 'b'] }, 'a', true), { mode: 'out', items: ['b'] });
    eq([A.filterLabel(A.noFilter(), k => k), A.filterLabel({ mode: 'in', items: ['a', 'b', 'c'] }, k => k.toUpperCase()),
        A.filterLabel({ mode: 'out', items: ['a'] }, k => k)], ['', 'A +2', 'кроме: a']);
    eq([A.asFilter('Вести (Р24)'), A.asFilter(''), A.asFilter(null)],
      [{ mode: 'in', items: ['Вести (Р24)'] }, { mode: 'in', items: [] }, { mode: 'in', items: [] }], 'сохранённое до 11.2026 — строка');
  });

  // свой блок: тесты Bitrix асинхронные и перезаписывают #out
  const out = document.body.appendChild(document.createElement('div'));
  const ok = results.filter(r => r.ok).length;
  out.insertAdjacentHTML('beforeend', `<h2 class="${ok === results.length ? 'pass' : 'fail'}">Аналитика: ${ok} / ${results.length} пройдено</h2>` +
    results.map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.err ? ` — ${r.err}` : ''}</div>`).join(''));
})();
