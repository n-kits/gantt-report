/* Тесты разборщика страницы Bitrix. Нужен http-сервер (fetch фикстуры). */
(async function () {
  'use strict';
  const B = window.GanttBitrix;
  const M = window.GanttModel;
  const results = window.__testResults || [];

  async function test(name, fn) {
    try { await fn(); results.push({ name: 'Bitrix: ' + name, ok: true }); } catch (e) { results.push({ name: 'Bitrix: ' + name, ok: false, err: e.message }); }
  }
  function eq(a, b, msg) {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`${msg || ''} ожидалось ${sb}, получено ${sa}`);
  }
  const parse = html => new DOMParser().parseFromString(html, 'text/html');
  const NOW = { y: 2026, mo: 9, d: 28, h: 22, mi: 32, s: 45 };

  await test('normalizeDate: форматы Bitrix', () => {
    eq(B.normalizeDate('26.09.2026 13:35', NOW), '26.09.2026 13:35:00');
    eq(B.normalizeDate(' 26.09.2026 12:03:00 ', NOW), '26.09.2026 12:03:00');
    eq(B.normalizeDate('Сегодня 08:58', NOW), '28.09.2026 08:58:00');
    eq(B.normalizeDate('Вчера 18:40', NOW), '27.09.2026 18:40:00');
    eq(B.normalizeDate('Завтра 10:00', NOW), '29.09.2026 10:00:00');
    eq(B.normalizeDate('26 сентября 13:35', NOW), '26.09.2026 13:35:00');
    eq(B.normalizeDate('30 декабря 2025 09:05', NOW), '30.12.2025 09:05:00');
    eq(B.normalizeDate('Вчера 23:15', { y: 2026, mo: 10, d: 1 }), '30.09.2026 23:15:00', 'через границу месяца');
    eq(B.normalizeDate('', NOW), '');
    eq(B.normalizeDate('не указан', NOW), '');
  });

  const html = await fetch('fixtures/bitrix-tasks.html').then(r => r.text());
  const res = B.parseBitrixTasks(parse(html));

  await test('страница: 25 задач, время сервера', () => {
    eq(res.count, 25);
    eq(res.now, '28.09.2026 22:32:45');
    eq(res.columns.length, 9);
  });

  await test('страница: поля первой задачи', () => {
    eq(res.rows[0].slice(0, 8), [
      'Вести (Р24): Карта СВО в растр_Спецоперация на Украине_ #1208807', 'Завершена',
      '26.09.2026 12:03:00', '26.09.2026 13:35:00', 'Петров Б.', '26.09.2026 13:00:00',
      'Вести (Р24)', 'Анимированная карта',
    ]);
    eq(res.rows[0][8].startsWith('Петров Борис Петрович (26.09.2026 13:35) = 2D: Анимация карты.'), true, res.rows[0][8]);
  });

  await test('страница: «Вчера»/«Сегодня» в завершении', () => {
    eq(res.rows[1][3], '27.09.2026 18:40:00');
    eq(res.rows[5][3], '28.09.2026 08:58:00');
    eq(res.rows.every(r => /^\d\d\.\d\d\.\d{4} \d\d:\d\d:\d\d$/.test(r[2])), true, 'регистрация везде');
  });

  await test('страница → лента', () => {
    const tl = M.buildTimeline(res.rows, { now: M.parseDt(res.now), step: 1, maxCols: 72 });
    eq(tl.rows.length, 25);
    eq(tl.subtitle.includes('26.09 04:00'), true, tl.subtitle);
  });

  await test('страница входа → LOGIN_REQUIRED', () => {
    try {
      B.parseBitrixTasks(parse('<form name="form_auth"><input name="USER_LOGIN"></form>'));
      throw new Error('не упало');
    } catch (e) { eq(e.code, 'LOGIN_REQUIRED'); }
  });

  await test('нет таблицы → NO_TABLE', () => {
    try { B.parseBitrixTasks(parse('<p>пусто</p>')); throw new Error('не упало'); } catch (e) { eq(e.code, 'NO_TABLE'); }
  });

  await test('постраничный вывод распознаётся', () => {
    eq(res.hasNextPage, false);
    const footer = on => `<div id="tasks-list-navigation-footer"><ul class="pagination">
      <li class="active"><a>1</a></li><li${on ? '' : ' class="disabled"'}><a>Cледующая &raquo;</a></li></ul></div>`;
    eq(B.parseBitrixTasks(parse(html.replace('</body>', footer(false) + '</body>'))).hasNextPage, false);
    eq(B.parseBitrixTasks(parse(html.replace('</body>', footer(true) + '</body>'))).hasNextPage, true);
  });

  await test('колонки по заголовкам, а не по порядку', () => {
    const doc = parse(html);
    const table = doc.querySelector('#task-list-table');
    // меняем местами «Статус» и «Регистрация» во всех строках
    for (const tr of table.querySelectorAll('tr')) {
      if (tr.cells.length > 3) tr.insertBefore(tr.cells[3], tr.cells[2]);
    }
    const r = B.parseBitrixTasks(doc);
    eq(r.rows[0].slice(1, 3), ['Завершена', '26.09.2026 12:03:00']);
  });

  await test('ID и ссылка задачи; без колонки «Описание» — пустое превью', () => {
    eq(res.tasks.length, res.count);
    eq(/^\d+$/.test(res.tasks[0].id), true);
    eq(/\/tasks\/task\/view\/\d+\/$/.test(res.tasks[0].url), true, res.tasks[0].url);
    eq(res.tasks[0].description, '');
  });

  await test('колонка «Описание»: превью с переносами строк', () => {
    const doc = parse(html);
    const table = doc.querySelector('#task-list-table');
    const th = doc.createElement('th');
    th.textContent = 'Описание';
    table.tHead.rows[0].appendChild(th);
    for (const tr of table.querySelectorAll('tbody tr.task-list-item')) {
      const td = doc.createElement('td');
      td.className = 'emg-task-description-preview';
      td.textContent = '\n      Дата монтажа: 27.09.2026 19:00 \nЗаголовок:  Прогноз   \nМосква, Сочи...   ';
      tr.appendChild(td);
    }
    const r = B.parseBitrixTasks(doc);
    eq(r.columns.includes('description'), true);
    eq(r.rows[0].length, 9, 'строки ленты не меняются');
    eq(r.tasks[0].description, 'Дата монтажа: 27.09.2026 19:00\nЗаголовок: Прогноз\nМосква, Сочи...');
  });

  // --- карта топонимов (js/map/geo-model.js) ---
  const G = window.GanttGeo;
  const at = (d, h, mi) => new Date(2026, 8, d, h, mi || 0);
  await test('карта: «сегодня» начинается в 04:00', () => {
    eq(G.dayStart(at(28, 22)).getTime(), at(28, 4).getTime());
    eq(G.dayStart(at(29, 3, 59)).getTime(), at(28, 4).getTime(), 'до 04:00 — ещё вчерашние сутки');
    eq(G.dayStart(at(29, 4)).getTime(), at(29, 4).getTime());
  });

  await test('карта: одинаковые топонимы сливаются, размер по числу задач', () => {
    const msk = { name: 'Москва', kind: 'settlement', lat: 55.7558, lon: 37.6173 };
    const geo = { items: [
      { id: '1', start: '28.09.2026 10:00:00', toponyms: [msk, { name: 'Украина', kind: 'country', iso: 'UKR' }] },
      { id: '2', start: '27.09.2026 10:00:00', toponyms: [Object.assign({}, msk, { name: 'москва', lat: 55.76 }), msk] },
      { id: '3', start: '27.09.2026 11:00:00', toponyms: [{ name: 'Чёрное море', kind: 'water', lat: 43.4, lon: 34, approx: true },
        { name: 'Украина', kind: 'country', iso: 'UKR' }, { name: 'Без координат', kind: 'other' }] },
      { id: '4', start: '28.09.2026 03:00:00', toponyms: [{ name: 'Сочи', kind: 'settlement', lat: 43.58, lon: 39.72 }] },
    ] };
    const a = G.aggregate(geo, at(28, 22));
    const byName = Object.fromEntries(a.points.map(p => [p.name, p]));
    eq([byName['Москва'].count, byName['Москва'].today], [2, true], 'дубль в одной задаче считается один раз');
    eq([byName['Чёрное море'].today, byName['Чёрное море'].approx], [false, true]);
    eq(byName['Сочи'].today, false, '03:00 — ещё вчера');
    eq(a.points.length, 3, 'без координат — пропуск');
    eq(a.countries.map(c => [c.iso, c.count, c.today]), [['UKR', 2, true]]);
    eq(a.points[a.points.length - 1].today, true, 'сегодняшние рисуются последними (сверху)');
    eq([G.radius(1), G.radius(2), G.radius(10), G.radius(1000)], [4, 5, 13, 40]);
    eq([byName['Москва'].byDay, byName['Сочи'].byDay, byName['Чёрное море'].byDay], [[1, 1, 0], [0, 1, 0], [0, 1, 0]], 'задачи по дням');
    const far = G.aggregate({ items: [{ id: '9', start: '25.09.2026 10:00:00', toponyms: [msk] }] }, at(28, 22));
    eq(far.points[0].byDay, [0, 0, 1], 'позавчера и раньше — в третью долю');
  });

  const out = document.getElementById('out');
  const ok = results.filter(r => r.ok).length;
  out.innerHTML = `<h2 class="${ok === results.length ? 'pass' : 'fail'}">${ok} / ${results.length} пройдено</h2>` +
    results.map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.err ? ` — ${r.err}` : ''}</div>`).join('');
})();
