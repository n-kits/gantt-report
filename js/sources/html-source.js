/*
 * Источник: HTML-страница списка задач Bitrix (сохранённая страница .html).
 *
 * Задел под получение данных напрямую из CRM: тот же разбор можно вызвать
 * на живой странице Bitrix (букмарклет / расширение) через parseHtml(document).
 * Разбор ищет грид Bitrix (table.main-grid-table), иначе — самую большую таблицу.
 */
(function (root) {
  'use strict';

  function cellText(cell) {
    const content = cell.querySelector('.main-grid-cell-content, .main-grid-head-title') || cell;
    return (content.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function pickTable(doc) {
    const grid = doc.querySelector('table.main-grid-table');
    if (grid) return grid;
    let best = null;
    let bestRows = 0;
    doc.querySelectorAll('table').forEach(t => {
      const n = t.rows.length;
      if (n > bestRows) { best = t; bestRows = n; }
    });
    return best;
  }

  // Убирает колонки, пустые во всех строках (чекбоксы, меню действий грида),
  // чтобы при отсутствии заголовков сохранялся порядок колонок выгрузки.
  function dropEmptyColumns(rows) {
    const width = Math.max(0, ...rows.map(r => r.length));
    const keep = [];
    for (let c = 0; c < width; c++) {
      if (rows.some(r => r[c] != null && r[c] !== '')) keep.push(c);
    }
    return rows.map(r => keep.map(c => (r[c] == null ? null : r[c])));
  }

  function parseHtml(doc) {
    const table = pickTable(doc);
    if (!table) throw new Error('На странице не найдено ни одной таблицы');
    const rows = [];
    for (const tr of table.rows) {
      if (tr.classList.contains('main-grid-row-empty') || tr.classList.contains('main-grid-nothing')) continue;
      rows.push(Array.from(tr.cells).map(cellText));
    }
    return dropEmptyColumns(rows.filter(r => r.some(v => v)));
  }

  const htmlSource = {
    id: 'html',
    label: 'HTML-страница (Bitrix)',
    accept: ['.html', '.htm'],

    canRead(file) {
      const n = (file.name || '').toLowerCase();
      return this.accept.some(ext => n.endsWith(ext));
    },

    async read(file) {
      const text = await file.text();
      const doc = new DOMParser().parseFromString(text, 'text/html');
      return { rows: parseHtml(doc), sourceName: file.name, kind: this.id };
    },
  };

  root.GanttSources = root.GanttSources || [];
  // HTML-адаптер проверяется первым: .html не должен уходить в SheetJS
  root.GanttSources.unshift(htmlSource);
  root.GanttHtml = { parseHtml };
})(window);
