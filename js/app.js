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
  };

  const state = {
    rows: null,
    sourceName: '',
    kind: '',
    now: null,
    step: 1,
    maxCols: String(M.MAX_TIMELINE_COLS),
  };
  let timeline = null;

  // --- хранение -------------------------------------------------------------
  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        rows: state.rows,
        sourceName: state.sourceName,
        kind: state.kind,
        now: state.now ? state.now.getTime() : null,
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
        now: s.now != null && !isNaN(new Date(s.now)) ? new Date(s.now) : null,
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
    el.step.value = String(state.step);
    el.maxCols.value = state.maxCols;
  }

  function rebuild() {
    syncControls();
    const has = !!(state.rows && state.rows.length);
    el.empty.hidden = has;
    el.scroller.hidden = !has;
    el.legend.hidden = !has;
    if (!has) {
      el.subtitle.textContent = 'Загрузите выгрузку задач, чтобы построить ленту.';
      el.source.textContent = '';
      return;
    }
    try {
      timeline = M.buildTimeline(state.rows, {
        now: state.now || new Date(),
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
      `${state.sourceName} · задач: ${timeline.tasks.length}`;
    save();
  }

  // --- события --------------------------------------------------------------
  document.querySelectorAll('.js-file').forEach(input => {
    input.addEventListener('change', () => {
      if (input.files[0]) loadFile(input.files[0]);
      input.value = '';
    });
  });

  el.step.addEventListener('change', () => { state.step = +el.step.value || 1; rebuild(); });
  el.maxCols.addEventListener('change', () => { state.maxCols = el.maxCols.value; rebuild(); });

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
      el.tooltip.innerHTML = T.tooltipHtml(r);
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

  document.getElementById('fields-list').innerHTML =
    M.FIELD_ORDER.map(k => `<li>${M.FIELD_TITLES[k]}</li>`).join('');

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
