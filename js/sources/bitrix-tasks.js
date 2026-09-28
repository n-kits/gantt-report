/*
 * Разбор страницы списка задач Bitrix (коробка + доработка «vizart»):
 * table#task-list-table → tr.task-list-item[data-id].
 *
 * Работает с любым Document: живой страницей (сборщик на Playwright вызывает
 * parseBitrixTasks(document)) и сохранённой страницей (DOMParser на сайте).
 *
 * Результат — строки в порядке колонок выгрузки «Отображаемый список задач»
 * (GanttModel.FIELD_ORDER), даты — строками «ДД.ММ.ГГГГ ЧЧ:ММ:СС» по времени
 * пользователя Bitrix. Подзадачи — обычные строки.
 */
(function (root) {
  'use strict';

  // Заголовок колонки Bitrix → поле. Сравнение по началу, без регистра.
  const HEADERS = [
    ['название', 'name'],
    ['статус', 'status'],
    ['регистрация', 'start'],
    ['завершение', 'finish'],
    ['текущий исполнитель', 'executor'],
    ['исполнитель', 'executor'],
    ['крайний срок', 'deadline'],
    ['проект', 'project'],
    ['вид продукции', 'product'],
    ['выполнение задачи', 'works'],
  ];
  const ORDER = ['name', 'status', 'start', 'finish', 'executor', 'deadline', 'project', 'product', 'works'];
  const REQUIRED = ['name', 'start'];

  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  class BitrixParseError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const pad2 = n => String(n).padStart(2, '0');

  // «Сейчас» по часам пользователя Bitrix: SERVER_TIME (unix) + смещения из BX.message.
  function readServerNow(doc) {
    const html = doc.documentElement ? doc.documentElement.innerHTML : '';
    const num = key => {
      const m = new RegExp(`['"]${key}['"]\\s*:\\s*['"]?(-?\\d+)`).exec(html);
      return m ? +m[1] : null;
    };
    const t = num('SERVER_TIME');
    if (t == null) return null;
    const shift = (num('SERVER_TZ_OFFSET') || 0) + (num('USER_TZ_OFFSET') || 0);
    const d = new Date((t + shift) * 1000);
    // компоненты «настенного» времени пользователя
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
      h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }

  function fmt(y, mo, d, h, mi, s) {
    return `${pad2(d)}.${pad2(mo)}.${y} ${pad2(h)}:${pad2(mi)}:${pad2(s || 0)}`;
  }

  function shiftDay(now, days) {
    const x = new Date(Date.UTC(now.y, now.mo - 1, now.d + days));
    return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate() };
  }

  /*
   * Текст даты из ячейки → «ДД.ММ.ГГГГ ЧЧ:ММ:СС» или '' (пусто / не распознано).
   * Форматы: «26.09.2026 13:35», «Сегодня 08:58», «Вчера 18:40», «Завтра 10:00»,
   * «26 сентября 13:35», «26 сентября 2026 13:35».
   */
  function normalizeDate(text, now) {
    const s = clean(text).toLowerCase();
    if (!s) return '';
    let m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return fmt(y, +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }
    m = /^(сегодня|вчера|завтра),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) {
      if (!now) return '';
      const day = shiftDay(now, { сегодня: 0, вчера: -1, завтра: 1 }[m[1]]);
      return fmt(day.y, day.mo, day.d, +m[2], +m[3], +(m[4] || 0));
    }
    m = /^(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?,?\s+(\d{1,2}):(\d{2})$/.exec(s);
    if (m && MONTHS.includes(m[2])) {
      const y = m[3] ? +m[3] : now ? now.y : new Date().getFullYear();
      return fmt(y, MONTHS.indexOf(m[2]) + 1, +m[1], +m[4], +m[5], 0);
    }
    return '';
  }

  function isLoginPage(doc) {
    return !!doc.querySelector('form[name="form_auth"], input[name="USER_LOGIN"], .bx-authform, .login-page');
  }

  function mapHeaders(table) {
    const head = table.tHead && table.tHead.rows[0];
    if (!head) throw new BitrixParseError('NO_HEADER', 'В таблице задач нет строки заголовков');
    const col = {};
    Array.from(head.cells).forEach((cell, i) => {
      const h = clean(cell.textContent).toLowerCase();
      if (!h) return;
      const hit = HEADERS.find(([prefix]) => h.startsWith(prefix));
      if (hit && !(hit[1] in col)) col[hit[1]] = i;
    });
    const missing = REQUIRED.filter(k => !(k in col));
    if (missing.length) {
      throw new BitrixParseError('NO_COLUMNS',
        `Не найдены колонки: ${missing.join(', ')}. Заголовки: ${Array.from(head.cells).map(c => clean(c.textContent)).filter(Boolean).join(' | ')}`);
    }
    return col;
  }

  function cellValue(field, td, now) {
    if (!td) return '';
    switch (field) {
      case 'name': {
        const a = td.querySelector('a.task-title-link');
        return clean(a ? a.textContent : td.textContent);
      }
      case 'start':
      case 'finish':
      case 'deadline': {
        const hidden = td.querySelector('input[type="hidden"]');
        const v = hidden && clean(hidden.value);
        return normalizeDate(v || td.textContent, now);
      }
      case 'works':
        // блоки «ФИО (дата) = работы» — через пробел, как в xlsx-выгрузке
        return Array.from(td.children).length
          ? Array.from(td.children).map(el => clean(el.textContent)).filter(Boolean).join(' ')
          : clean(td.textContent);
      default:
        return clean(td.textContent);
    }
  }

  /*
   * → { rows, now, count, columns }
   *   rows — массив массивов в порядке ORDER; now — «сейчас» Bitrix строкой.
   * Ошибки — BitrixParseError с code: LOGIN_REQUIRED, NO_TABLE, NO_HEADER, NO_COLUMNS.
   */
  function parseBitrixTasks(doc) {
    doc = doc || root.document;
    if (isLoginPage(doc)) throw new BitrixParseError('LOGIN_REQUIRED', 'Требуется вход в Bitrix');
    const table = doc.querySelector('table#task-list-table');
    if (!table) throw new BitrixParseError('NO_TABLE', 'На странице нет таблицы задач (table#task-list-table)');
    const col = mapHeaders(table);
    const now = readServerNow(doc);
    const rows = [];
    for (const tr of table.querySelectorAll('tbody tr.task-list-item[data-id]')) {
      const cells = tr.cells;
      rows.push(ORDER.map(f => (f in col ? cellValue(f, cells[col[f]], now) : '')));
    }
    // Постраничный вывод: активна ссылка «Следующая» — значит, задачи не все
    const next = Array.from(doc.querySelectorAll('#tasks-list-navigation-footer .pagination li'))
      .find(li => /следующая/i.test(li.textContent.replace(/[CС]ледующая/, 'Следующая')));
    const hasNextPage = !!next && !next.classList.contains('disabled');
    return {
      rows,
      now: now ? fmt(now.y, now.mo, now.d, now.h, now.mi, now.s) : null,
      count: rows.length,
      columns: Object.keys(col),
      hasNextPage,
    };
  }

  const api = { parseBitrixTasks, normalizeDate, BitrixParseError, ORDER };
  root.GanttBitrix = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
