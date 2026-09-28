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

  const out = document.getElementById('out');
  const ok = results.filter(r => r.ok).length;
  out.innerHTML = `<h2 class="${ok === results.length ? 'pass' : 'fail'}">${ok} / ${results.length} пройдено</h2>` +
    results.map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.err ? ` — ${r.err}` : ''}</div>`).join('');
})();
