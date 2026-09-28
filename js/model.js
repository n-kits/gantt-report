/*
 * Модель данных ленты времени — порт логики gantt_report.py (load_tasks,
 * infer_window, bar_color, write_timeline) в браузер.
 *
 * Вход — «сырые» строки таблицы (массив массивов), независимо от источника:
 * xlsx, HTML-страница Bitrix и т.п. Все даты — локальное «наивное» время,
 * как в Python-скрипте.
 */
(function (root) {
  'use strict';

  const STATUS_DONE = 'Завершена';
  const STATUS_REVIEW = 'На рассмотрении';
  const STATUS_RUN = 'Выполняется';

  const DAY_START_HOUR = 4; // ось всегда начинается с 04:00
  const MAX_TIMELINE_COLS = 72;
  const HOUR = 3600 * 1000;

  // Порядок колонок выгрузки Bitrix «Отображаемый список задач». Заголовков нет.
  const FIELD_ORDER = ['name', 'status', 'start', 'finish', 'executor', 'deadline', 'project', 'product', 'works'];
  const FIELD_TITLES = {
    name: 'Название задачи', status: 'Статус', start: 'Регистрация', finish: 'Завершение',
    executor: 'Текущий исполнитель', deadline: 'Крайний срок', project: 'Проект заказчика',
    product: 'Вид продукции', works: 'Выполнение задачи',
  };

  const C = {
    navy: '#1B3A4B', header: '#0F2C3A', teal: '#1A6B6B', accent: '#C45C26',
    white: '#FFFFFF', line: '#D4CFC4',
    green: '#2E7D4F', green_bg: '#D8EDE0', orange: '#C47A16', orange_bg: '#F8E6C8',
    blue: '#2B6CB0', blue_bg: '#D6E6F5', red: '#B42318', red_bg: '#F8D7D3',
    gray: '#6B7280', gray_bg: '#EEECE6', gold: '#C9A227', light: '#FAF8F3', alt: '#F0EBE1',
  };
  const STATUS_COLOR = { [STATUS_DONE]: C.green, [STATUS_REVIEW]: C.orange, [STATUS_RUN]: C.blue };
  const STATUS_BG = { [STATUS_DONE]: C.green_bg, [STATUS_REVIEW]: C.orange_bg, [STATUS_RUN]: C.blue_bg };
  const EXEC_PALETTE = ['#1D4E89', '#0F766E', '#9A3412', '#7C3AED', '#BE185D', '#365314', '#0E7490', '#92400E'];
  const DAY_PALETTE = ['#1D4E89', '#9A3412', '#0F766E', '#6B21A8', '#92400E'];

  // ---------------------------------------------------------------------------
  // Разбор значений
  // ---------------------------------------------------------------------------

  function isValidDate(d) {
    return d instanceof Date && !isNaN(d.getTime());
  }

  // Excel serial (дни от 1899-12-30) → локальная дата.
  function fromExcelSerial(n) {
    const days = Math.floor(n);
    const secs = Math.round((n - days) * 86400);
    return new Date(1899, 11, 30 + days, 0, 0, secs);
  }

  // Двузначный год — как в Python %y: 69–99 → 19xx, 00–68 → 20xx.
  function fullYear(y) {
    if (y.length === 4) return +y;
    const n = +y;
    return n <= 68 ? 2000 + n : 1900 + n;
  }

  function makeDate(y, mo, d, h, mi, s) {
    const dt = new Date(y, mo - 1, d, h || 0, mi || 0, s || 0);
    // отсекаем 31.02 и т.п. — strptime такие даты не принимает
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  const RE_DMY = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  const RE_YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

  function parseDt(v) {
    if (v == null) return null;
    if (v instanceof Date) return isValidDate(v) ? new Date(v.getTime()) : null;
    if (typeof v === 'number') return isFinite(v) && v > 0 ? fromExcelSerial(v) : null;
    const s = String(v).trim();
    if (!s) return null;
    let m = RE_DMY.exec(s);
    if (m) return makeDate(fullYear(m[3]), +m[2], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = RE_YMD.exec(s);
    if (m) return makeDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return null;
  }

  function extractId(name) {
    if (!name) return '';
    const parts = String(name).split('#');
    return parts.length > 1 ? parts[parts.length - 1].trim() : '';
  }

  function shortName(name, maxlen) {
    maxlen = maxlen || 62;
    if (!name) return '';
    let s = String(name);
    const hash = s.lastIndexOf('#');
    if (hash >= 0) s = s.slice(0, hash).trim();
    const colon = s.indexOf(':');
    if (colon >= 0 && s.slice(0, colon).includes('(Р24)')) s = s.slice(colon + 1).trim();
    for (const junk of ['Карта_плазма_', 'Карта СВО плазма_', 'Стандартная карта на плазму_', '_карта сво_', ' в растр']) {
      s = s.split(junk).join('');
    }
    // Python считает длину в кодовых точках
    const chars = Array.from(s);
    if (chars.length > maxlen) s = chars.slice(0, maxlen - 1).join('') + '…';
    return s;
  }

  function guessNowFromFilename(name) {
    const m = /(20\d{2})[_-](\d{2})[_-](\d{2})[_-](\d{2})[_-](\d{2})[_-](\d{2})/.exec(name || '');
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
    const dt = makeDate(y, mo, d, h, mi, s);
    return dt && dt.getHours() === h && dt.getMinutes() === mi ? dt : null;
  }

  const COL = {};
  FIELD_ORDER.forEach((k, i) => { COL[k] = i; });

  function isEmptyRow(raw) {
    return !raw || raw.every(c => c == null || String(c).trim() === '');
  }

  // ---------------------------------------------------------------------------
  // Задачи
  // ---------------------------------------------------------------------------

  function loadTasks(rows, now) {
    if (!rows || !rows.length) throw new Error('Пустая таблица');
    const tasks = [];
    for (let r = 0; r < rows.length; r++) {
      const raw = rows[r];
      if (isEmptyRow(raw)) continue;
      const get = key => {
        const i = COL[key];
        return i != null && i < raw.length ? raw[i] : null;
      };
      const name = String(get('name') == null ? '' : get('name')).trim();
      if (!name) continue;
      const start = parseDt(get('start'));
      // строка без даты регистрации — шапка или мусор
      if (!start) continue;
      const finish = parseDt(get('finish'));
      const deadline = parseDt(get('deadline'));
      const status = String(get('status') == null ? '' : get('status')).trim();
      const actualEnd = finish || now;
      const durationH = start ? (actualEnd - start) / HOUR : 0;
      let delayH = null;
      let late = false;
      if (deadline && actualEnd) {
        delayH = (actualEnd - deadline) / HOUR;
        if (status === STATUS_RUN) {
          late = now > deadline;
          delayH = (now - deadline) / HOUR;
        } else {
          late = delayH > 0;
        }
      }
      tasks.push({
        id: extractId(name),
        name,
        short: shortName(name),
        project: String(get('project') == null ? '' : get('project')).trim(),
        start,
        finish,
        actualEnd,
        executor: String(get('executor') == null ? '' : get('executor')).trim() || '—',
        works: String(get('works') == null ? '' : get('works')),
        status: status || '—',
        deadline,
        product: String(get('product') == null ? '' : get('product')).trim() || '—',
        durationH,
        late,
        delayH,
      });
    }
    tasks.sort((a, b) => {
      const d = (a.start || now) - (b.start || now);
      if (d) return d;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    if (!tasks.length) throw new Error('Не удалось прочитать ни одной задачи');
    return { tasks };
  }

  function floorHour(d) {
    const x = new Date(d.getTime());
    x.setMinutes(0, 0, 0);
    return x;
  }

  function addHours(d, h) {
    // через компоненты даты, чтобы не зависеть от перехода на летнее время
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + h, d.getMinutes(), d.getSeconds());
  }

  function inferWindow(tasks, now, opts) {
    const step = opts.step || 1;
    const maxCols = opts.maxCols || MAX_TIMELINE_COLS;
    const starts = tasks.filter(t => t.start).map(t => t.start);
    const ends = tasks.filter(t => t.actualEnd).map(t => t.actualEnd);
    if (!starts.length) throw new Error('Нет ни одной даты регистрации');
    const first = new Date(Math.min(...starts));
    const last = new Date(Math.max(...ends, now));
    // 04:00 дня первой задачи; если задача раньше 04:00 — 04:00 предыдущего дня
    const cand = new Date(first.getFullYear(), first.getMonth(), first.getDate(), DAY_START_HOUR, 0, 0);
    const base = cand <= first ? cand : new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1, DAY_START_HOUR);
    const end = addHours(floorHour(last), 1);
    const n = Math.floor(Math.floor((end - base) / HOUR) / step);
    const nSlots = Math.max(8, Math.min(maxCols, n + 1));
    return { base, end, step, nSlots };
  }

  function execColorMap(tasks) {
    const map = new Map();
    for (const t of tasks) {
      if (!map.has(t.executor)) map.set(t.executor, EXEC_PALETTE[map.size % EXEC_PALETTE.length]);
    }
    return map;
  }

  function barColor(t) {
    if (t.late && t.status === STATUS_RUN) return C.accent;
    if (t.late && t.status === STATUS_REVIEW) return '#9A3412';
    if (t.late) return C.red;
    return STATUS_COLOR[t.status] || C.gray;
  }

  function capacityColor(cnt) {
    if (cnt >= 12) return '#7F1D1D';
    if (cnt >= 8) return '#C2410C';
    if (cnt >= 5) return '#CA8A04';
    if (cnt >= 3) return '#A3B18A';
    return '#E8E4D9';
  }

  const pad2 = n => String(n).padStart(2, '0');
  const fmtDate = d => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
  const fmtDM = d => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
  const fmtHM = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const fmtDMHM = d => (d ? `${fmtDM(d)} ${fmtHM(d)}` : '—');
  const fmtFull = d => (d ? `${fmtDate(d)} ${fmtHM(d)}` : '—');

  /*
   * Полный расчёт ленты времени: окно, заголовки дней/часов, ячейки по задачам,
   * строка «Одновременно в работе». Рендер не содержит бизнес-логики.
   */
  function buildTimeline(rows, opts) {
    const now = opts.now;
    const loaded = loadTasks(rows, now);
    const tasks = loaded.tasks;
    const win = inferWindow(tasks, now, opts);
    const { base, step, nSlots } = win;
    const slotMs = step * HOUR;

    const hours = [];
    for (let i = 0; i < nSlots; i++) hours.push(addHours(base, i * step));

    const dayGroups = [];
    hours.forEach((h, i) => {
      const key = fmtDate(h);
      const g = dayGroups[dayGroups.length - 1];
      if (!g || g.label !== key) dayGroups.push({ label: key, from: i, to: i });
      else g.to = i;
    });
    dayGroups.forEach((g, gi) => { g.color = DAY_PALETTE[gi % DAY_PALETTE.length]; });

    // часы окрашиваются в цвет своего дня
    const hourHeads = hours.map((h, i) => ({
      label: pad2(h.getHours()),
      color: dayGroups.find(g => g.from <= i && i <= g.to).color,
      date: h,
    }));

    const execColors = execColorMap(tasks);
    const clamp = i => Math.max(0, Math.min(nSlots - 1, i));

    const taskRows = tasks.map(t => {
      let startIdx = null;
      let endIdx = null;
      if (t.start && t.actualEnd) {
        startIdx = clamp(Math.floor((t.start - base) / slotMs));
        endIdx = clamp(Math.floor(((t.actualEnd - base) / 1000 - 1) / (slotMs / 1000)));
      }
      let dlIdx = null;
      if (t.deadline) {
        const di = Math.floor((t.deadline - base) / slotMs);
        if (di >= 0 && di < nSlots) dlIdx = di;
      }
      return {
        task: t,
        barColor: barColor(t),
        execShort: t.executor ? t.executor.split(/\s+/)[0] : '—',
        execColor: execColors.get(t.executor) || '#1F2937',
        statusColor: STATUS_COLOR[t.status] || C.gray,
        statusBg: STATUS_BG[t.status] || C.gray_bg,
        startIdx,
        endIdx,
        dlIdx,
      };
    });

    const capacity = hours.map(hs => {
      const he = addHours(hs, step);
      const cnt = tasks.filter(t => t.start && t.actualEnd && t.start < he && t.actualEnd > hs).length;
      return { count: cnt, color: capacityColor(cnt), textColor: cnt >= 8 ? C.white : C.navy };
    });

    const windowEnd = addHours(base, nSlots * step);
    return {
      now,
      base,
      end: win.end,
      windowEnd,
      step,
      nSlots,
      tasks,
      dayGroups,
      hourHeads,
      rows: taskRows,
      capacity,
      subtitle:
        `Колонка = ${step} ч. Заливка — задача шла в этом интервале. «◆» — крайний срок. ` +
        `${fmtDMHM(base)} → ${fmtDMHM(windowEnd)}.`,
    };
  }

  const api = {
    STATUS_DONE, STATUS_REVIEW, STATUS_RUN,
    DAY_START_HOUR, MAX_TIMELINE_COLS, FIELD_ORDER, FIELD_TITLES, C,
    parseDt, extractId, shortName, guessNowFromFilename,
    loadTasks, inferWindow, barColor, capacityColor, buildTimeline,
    fmtFull, fmtDMHM,
  };
  root.GanttModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
