/*
 * Связка: загрузка источника → модель → рендер. Последний набор данных
 * и настройки хранятся в localStorage, чтобы страница переживала перезагрузку.
 */
(function (root) {
  'use strict';

  const M = root.GanttModel;
  const T = root.GanttTimeline;
  const STORAGE_KEY = 'gantt-timeline.v1';

  const $ = sel => document.querySelector(sel);
  const el = {
    now: $('#now'),
    dayStart: $('#day-start'),
    step: $('#step'),
    maxCols: $('#max-cols'),
    subtitle: $('#subtitle'),
    source: $('#source'),
    msg: $('#msg'),
    scroller: $('#scroller'),
    empty: $('#empty'),
    legend: $('#legend'),
    drop: $('#drop'),
    tooltip: $('#tooltip'),
    print: $('#print'),
  };

  const state = {
    rows: null,
    sourceName: '',
    kind: '',
    now: null,
    dayStart: M.DEFAULT_DAY_START_HOUR,
    step: 1,
    maxCols: String(M.MAX_TIMELINE_COLS),
  };
  let timeline = null;

  // --- даты для <input type="datetime-local"> ------------------------------
  const pad2 = n => String(n).padStart(2, '0');
  function toLocalInput(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  function fromLocalInput(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
  }

  // --- хранение -------------------------------------------------------------
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        rows: state.rows,
        sourceName: state.sourceName,
        kind: state.kind,
        now: state.now ? toLocalInput(state.now) : null,
        dayStart: state.dayStart,
        step: state.step,
        maxCols: state.maxCols,
      }));
    } catch (e) { /* квота/приватный режим — не критично */ }
  }

  function restore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!s) return;
      Object.assign(state, {
        rows: Array.isArray(s.rows) ? s.rows : null,
        sourceName: s.sourceName || '',
        kind: s.kind || '',
        now: fromLocalInput(s.now),
        dayStart: s.dayStart == null ? state.dayStart : s.dayStart,
        step: +s.step || 1,
        maxCols: s.maxCols || state.maxCols,
      });
    } catch (e) { /* повреждённые данные — начинаем с чистого листа */ }
  }

  // --- сообщения ------------------------------------------------------------
  function showMsg(text, kind) {
    el.msg.textContent = text || '';
    el.msg.className = 'msg' + (text ? ' show ' + (kind || 'info') : '');
  }

  // --- загрузка -------------------------------------------------------------
  async function loadFile(file) {
    const src = (root.GanttSources || []).find(s => s.canRead(file));
    if (!src) {
      showMsg(`Формат файла «${file.name}» не поддерживается. Нужен .xlsx, .xls, .csv или .html`, 'error');
      return;
    }
    try {
      const res = await src.read(file);
      state.rows = res.rows;
      state.sourceName = res.sourceName;
      state.kind = res.kind;
      state.now = M.guessNowFromFilename(res.sourceName) || new Date();
      showMsg('');
      rebuild();
    } catch (e) {
      console.error(e);
      showMsg(`Не удалось прочитать «${file.name}»: ${e.message}`, 'error');
    }
  }

  // --- перестроение ---------------------------------------------------------
  function syncControls() {
    el.now.value = state.now ? toLocalInput(state.now) : '';
    el.dayStart.value = state.dayStart;
    el.step.value = String(state.step);
    el.maxCols.value = state.maxCols;
  }

  function rebuild() {
    syncControls();
    const has = !!(state.rows && state.rows.length);
    el.empty.hidden = has;
    el.scroller.hidden = !has;
    el.legend.hidden = !has;
    el.print.disabled = !has;
    if (!has) {
      el.subtitle.textContent = 'Загрузите выгрузку задач, чтобы построить ленту.';
      el.source.textContent = '';
      return;
    }
    try {
      timeline = M.buildTimeline(state.rows, {
        now: state.now || new Date(),
        dayStartHour: state.dayStart === '' ? null : +state.dayStart,
        step: state.step,
        maxCols: state.maxCols === 'all' ? Infinity : +state.maxCols,
      });
    } catch (e) {
      console.error(e);
      timeline = null;
      el.scroller.innerHTML = '';
      showMsg(`Ошибка построения: ${e.message}`, 'error');
      return;
    }
    el.scroller.innerHTML = T.render(timeline);
    el.subtitle.textContent = timeline.subtitle;
    el.source.textContent =
      `${state.sourceName} · задач: ${timeline.tasks.length} · расчёт на ${M.fmtFull(timeline.now)}`;
    if (timeline.positional) {
      showMsg('Заголовки колонок не распознаны — колонки взяты по стандартному порядку выгрузки.', 'warn');
    } else if (el.msg.classList.contains('warn')) {
      showMsg('');
    }
    save();
  }

  // --- события --------------------------------------------------------------
  document.querySelectorAll('.js-file').forEach(input => {
    input.addEventListener('change', () => {
      if (input.files[0]) loadFile(input.files[0]);
      input.value = '';
    });
  });

  el.now.addEventListener('change', () => {
    const d = fromLocalInput(el.now.value);
    if (d) { state.now = d; rebuild(); }
  });
  el.dayStart.addEventListener('change', () => {
    const v = el.dayStart.value.trim();
    state.dayStart = v === '' ? '' : Math.max(0, Math.min(23, parseInt(v, 10) || 0));
    rebuild();
  });
  el.step.addEventListener('change', () => { state.step = +el.step.value || 1; rebuild(); });
  el.maxCols.addEventListener('change', () => { state.maxCols = el.maxCols.value; rebuild(); });
  el.print.addEventListener('click', () => window.print());

  // drag & drop на всё окно
  let dragDepth = 0;
  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    el.drop.classList.add('show');
  });
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) el.drop.classList.remove('show');
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    el.drop.classList.remove('show');
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // подсказка по задаче
  el.scroller.addEventListener('mousemove', e => {
    const tr = e.target.closest('tr.task');
    if (!tr || !timeline) { el.tooltip.hidden = true; return; }
    const r = timeline.rows[+tr.dataset.i];
    if (el.tooltip.dataset.i !== tr.dataset.i) {
      el.tooltip.innerHTML = T.tooltipHtml(r, timeline.now);
      el.tooltip.dataset.i = tr.dataset.i;
    }
    el.tooltip.hidden = false;
    const w = el.tooltip.offsetWidth;
    const h = el.tooltip.offsetHeight;
    let x = e.clientX + 16;
    let y = e.clientY + 16;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 16;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 16;
    el.tooltip.style.left = Math.max(8, x) + 'px';
    el.tooltip.style.top = Math.max(8, y) + 'px';
  });
  el.scroller.addEventListener('mouseleave', () => { el.tooltip.hidden = true; });

  restore();
  rebuild();

  // точка входа для будущих источников (букмарклет Bitrix, API и т.п.)
  root.GanttApp = {
    loadRows(rows, sourceName, now) {
      state.rows = rows;
      state.sourceName = sourceName || 'данные';
      state.kind = 'external';
      state.now = now || M.guessNowFromFilename(sourceName) || new Date();
      showMsg('');
      rebuild();
    },
  };
})(window);
