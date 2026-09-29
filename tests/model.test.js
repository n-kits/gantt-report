/* Тесты модели. Запуск: открыть tests/index.html в браузере. */
(function () {
  'use strict';
  const M = window.GanttModel;
  const results = [];

  function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, err: e.message }); }
  }
  function eq(a, b, msg) {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`${msg || ''} ожидалось ${sb}, получено ${sa}`);
  }
  const d = (...a) => new Date(a[0], a[1] - 1, a[2], a[3] || 0, a[4] || 0, a[5] || 0);
  const iso = x => (x ? `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()} ${x.getHours()}:${x.getMinutes()}:${x.getSeconds()}` : null);

  // Порядок Bitrix: название, статус, регистрация, завершение, исполнитель,
  // крайний срок, проект, вид продукции, выполнение задачи.
  // Первая строка выгрузки — «шапка» из одних пробелов.
  const BLANK = [null, ' ', '  ', '   ', '    ', '     ', '      ', '       ', '        '];
  const ROWS = [
    ['Погода (Р24): Прогноз 14 сентября #100', 'Завершена', '14.09.26 07:59:00', '14.09.26 09:23:05', 'Иванова А.', '14.09.26 09:30:00', 'Погода (Р24)', 'Плазма', ''],
    ['Вести (Р24): Карта_плазма_Киев #101', 'Завершена', '14.09.26 08:05:00', '14.09.26 09:02:57', 'Петров Б.', '14.09.26 09:00:00', 'Вести (Р24)', 'Плазма', ''],
    ['Факты (Р24): Карта в растр #102', 'Выполняется', '14.09.26 10:10:00', '', 'Иванова А.', '14.09.26 11:00:00', 'Факты (Р24)', 'Анимированная карта', ''],
    ['Факты (Р24): Схема #103', 'На рассмотрении', '14.09.26 10:20:00', '', 'Сидоров В.', '14.09.26 18:00:00', 'Факты (Р24)', 'Плазма', ''],
  ];
  const DATA = [BLANK].concat(ROWS);
  const NOW = d(2026, 9, 14, 12, 30);

  test('parseDt: форматы выгрузки', () => {
    eq(iso(M.parseDt('14.09.26 07:59:00')), '2026-9-14 7:59:0');
    eq(iso(M.parseDt('14.09.2026 07:59')), '2026-9-14 7:59:0');
    eq(iso(M.parseDt('2026-09-14 07:59:10')), '2026-9-14 7:59:10');
    eq(iso(M.parseDt('14.09.2026')), '2026-9-14 0:0:0');
    eq(iso(M.parseDt('01.01.70')), '1970-1-1 0:0:0', '%y 70 → 1970');
    eq(M.parseDt('31.02.2026'), null);
    eq(M.parseDt(''), null);
    eq(M.parseDt('вчера'), null);
  });

  test('parseDt: Excel serial', () => {
    eq(iso(M.parseDt(46279.5)), '2026-9-14 12:0:0');
  });

  test('extractId / shortName', () => {
    eq(M.extractId('Погода (Р24): Прогноз #1205938'), '1205938');
    eq(M.extractId('без номера'), '');
    eq(M.shortName('Вести (Р24): Карта_плазма_Киев в растр #101'), 'Киев');
    eq(Array.from(M.shortName('x'.repeat(80))).length, 62);
  });

  test('guessNowFromFilename', () => {
    eq(iso(M.guessNowFromFilename('Отображаемый_список_задач_2026_09_27_03_00_46.xlsx')), '2026-9-27 3:0:46');
    eq(M.guessNowFromFilename('выгрузка.xlsx'), null);
  });

  test('loadTasks: поля по порядку колонок Bitrix', () => {
    const t = M.loadTasks(DATA, NOW).tasks[0];
    eq([t.id, t.status, iso(t.start), iso(t.finish), t.executor, iso(t.deadline), t.project, t.product],
      ['100', 'Завершена', '2026-9-14 7:59:0', '2026-9-14 9:23:5', 'Иванова А.', '2026-9-14 9:30:0', 'Погода (Р24)', 'Плазма']);
  });

  test('loadTasks: шапка из пробелов и мусорные строки пропускаются', () => {
    eq(M.loadTasks(DATA, NOW).tasks.length, 4);
    eq(M.loadTasks(ROWS, NOW).tasks.length, 4);
    eq(M.loadTasks([['Отчёт'], ['Название', 'Статус', 'Регистрация']].concat(ROWS), NOW).tasks.length, 4);
  });

  test('loadTasks: просрочки и цвета баров', () => {
    const { tasks } = M.loadTasks(DATA, NOW);
    const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
    eq(byId['100'].late, false);
    eq(M.barColor(byId['100']), '#2E7D4F');
    eq(byId['101'].late, true);
    eq(M.barColor(byId['101']), '#B42318');
    eq(byId['102'].late, true, 'выполняется после срока');
    eq(M.barColor(byId['102']), '#E2D6F3', 'выполняется, срок прошёл — светло-фиолетовый');
    eq(byId['103'].late, false);
    eq(M.barColor(byId['103']), '#C4E3CF', 'на рассмотрении в срок — светло-зелёный');
    eq(iso(byId['103'].actualEnd), iso(NOW));
  });

  test('светлые полосы: «на рассмотрении, срок нарушен» и цвет «◆»', () => {
    const late = ['Схема #104', 'На рассмотрении', '14.09.26 10:00:00', '14.09.26 12:00:00', 'Сидоров В.', '14.09.26 11:00:00', '', '', ''];
    const tl = M.buildTimeline(DATA.concat([late]), { now: NOW, step: 1 });
    const mark = id => tl.rows.find(r => r.task.id === id);
    eq([mark('104').barColor, mark('104').barMark], ['#F3C6C0', '#B42318'], 'светло-красная, красный ◆');
    eq([mark('103').barColor, mark('103').barMark], ['#C4E3CF', '#2E7D4F'], 'светло-зелёная, зелёный ◆');
    eq([mark('102').barColor, mark('102').barMark], ['#E2D6F3', '#6B21A8'], 'светло-фиолетовая, фиолетовый ◆');
    eq([mark('100').barColor, mark('100').barMark], ['#2E7D4F', '#FFFFFF'], 'насыщенная — белый ◆');
    eq([mark('100').statusColor, mark('100').statusBg], ['#FFFFFF', '#2E7D4F'], 'плашка «Завершена»');
    eq([mark('103').statusColor, mark('103').statusBg], ['#2E7D4F', '#D8EDE0'], 'плашка «На рассмотрении»');
  });

  test('inferWindow: ось с 04:00, минимум 8 колонок, лимит 72', () => {
    const { tasks } = M.loadTasks(DATA, NOW);
    const w = M.inferWindow(tasks, NOW, { step: 1, maxCols: 72 });
    eq(iso(w.base), '2026-9-14 4:0:0');
    eq(iso(w.end), '2026-9-14 13:0:0');
    eq(w.nSlots, 16, '10 колонок данных + 6 запаса');
    const early = M.loadTasks(DATA.concat([['Ночная #9', 'Завершена', '14.09.26 02:30:00', '14.09.26 03:10:00', '', '', '', '', '']]), NOW).tasks;
    eq(iso(M.inferWindow(early, NOW, { step: 1, maxCols: 72 }).base), '2026-9-13 4:0:0', 'задача до 04:00 → 04:00 предыдущего дня');
    const far = d(2026, 9, 30);
    eq(M.inferWindow(tasks, far, { step: 1, maxCols: 72 }).nSlots, 78, '72 + запас');
    eq(M.inferWindow(tasks, far, { step: 1, maxCols: Infinity }).nSlots, 388);
    eq(M.inferWindow(tasks, far, { step: 1, maxCols: 24 }).nSlots, 30);
    eq(M.inferWindow(tasks, far, { step: 1, maxCols: 48 }).nSlots, 54);
    eq(M.inferWindow(tasks, NOW, { step: 1, maxCols: 24 }).nSlots, 16, 'данных меньше лимита');
  });

  test('buildTimeline: интервалы, срок, загрузка', () => {
    const tl = M.buildTimeline(DATA, { now: NOW, step: 1 });
    const r0 = tl.rows[0];
    eq([r0.startIdx, r0.endIdx, r0.dlIdx], [3, 5, 5], '07:59 → 09:23, срок 09:30');
    eq(tl.hourHeads.map(h => h.label).slice(0, 3), ['04', '05', '06']);
    eq(tl.dayGroups.length, 1);
    eq(tl.capacity.map(c => c.count), [0, 0, 0, 1, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0]);
    eq(tl.subtitle.includes('14.09 04:00 → 14.09 20:00'), true);
  });

  test('buildTimeline: часы в цвет своего дня', () => {
    const tl = M.buildTimeline(DATA, { now: d(2026, 9, 15, 6, 0), step: 1 });
    eq(tl.dayGroups.length, 2);
    tl.dayGroups.forEach(g => {
      for (let i = g.from; i <= g.to; i++) eq(tl.hourHeads[i].color, g.color, `час ${i}`);
    });
    eq(tl.dayGroups[0].color !== tl.dayGroups[1].color, true);
  });

  test('buildTimeline: шаг 2 ч', () => {
    const tl = M.buildTimeline(DATA, { now: NOW, step: 2 });
    eq(tl.nSlots, 11, '5 колонок данных + 6 запаса');
    eq([tl.rows[0].startIdx, tl.rows[0].endIdx], [1, 2]);
  });

  window.__testResults = results;
  const ok = results.filter(r => r.ok).length;
  const out = document.getElementById('out');
  out.innerHTML = `<h2 class="${ok === results.length ? 'pass' : 'fail'}">${ok} / ${results.length} пройдено</h2>` +
    results.map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.err ? ` — ${r.err}` : ''}</div>`).join('');
})();
