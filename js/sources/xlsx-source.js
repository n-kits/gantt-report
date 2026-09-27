/*
 * Источник: файл выгрузки (.xlsx, .xls, .csv, .ods).
 * Экспорт Bitrix «в Excel» на самом деле HTML-таблица с расширением .xls —
 * SheetJS читает и её.
 */
(function (root) {
  'use strict';

  const xlsxSource = {
    id: 'xlsx',
    label: 'Файл Excel',
    accept: ['.xlsx', '.xlsm', '.xls', '.ods', '.csv'],

    canRead(file) {
      const n = (file.name || '').toLowerCase();
      return this.accept.some(ext => n.endsWith(ext));
    },

    async read(file) {
      if (typeof XLSX === 'undefined') throw new Error('Библиотека SheetJS не загружена (vendor/xlsx.full.min.js)');
      const buf = await file.arrayBuffer();
      // raw: не давать SheetJS «угадывать» даты в текстовых/HTML таблицах —
      // формат «14.09.26 07:59:00» разбирает модель.
      const wb = XLSX.read(buf, { type: 'array', raw: true, cellDates: false, dense: true });
      const view = wb.Workbook && wb.Workbook.WBView && wb.Workbook.WBView[0];
      const active = view && view.activeTab != null ? view.activeTab : 0;
      const sheetName = wb.SheetNames[active] || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: false });
      return { rows, sourceName: file.name, kind: this.id };
    },
  };

  root.GanttSources = root.GanttSources || [];
  root.GanttSources.push(xlsxSource);
})(window);
