/*
 * Период из архива: сборщик публикует в ветку data по файлу на рабочий день
 * (days/ГГГГ-ММ-ДД.json, зашифровано тем же паролем) и открытый days/index.json —
 * какие дни есть и когда их статусы сверены с Bitrix. Выбрали дату и число дней —
 * страница скачивает эти дни, расшифровывает и строит ленту на конец периода.
 */
(function (root) {
  'use strict';

  const M = root.GanttModel;
  const App = root.GanttApp;
  const L = root.GanttLive;
  if (!L) return;
  const POS_KEY = 'gantt-archive.period';

  const base = L.dataUrl.replace(/[^/]*$/, '') + 'days/';
  const $ = sel => document.querySelector(sel);
  const el = {
    box: $('#period'),
    from: $('#period-from'),
    len: $('#period-len'),
    prev: $('#period-prev'),
    next: $('#period-next'),
    show: $('#period-show'),
  };
  let index = null;

  // --- даты: рабочий день ГГГГ-ММ-ДД, сутки с 04:00 --------------------------
  const pad2 = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, k) => { const d = fromIso(s); d.setDate(d.getDate() + k); return iso(d); };
  const dm = s => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  const today = () => iso(new Date(Date.now() - M.DAY_START_HOUR * 3600000));
  const fmtAt = s => { const d = new Date(s); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

  // конец периода — 04:00 следующего после последнего дня; если он ещё не наступил — текущий момент
  function periodNow(lastDay) {
    const end = fromIso(addDays(lastDay, 1));
    end.setHours(M.DAY_START_HOUR);
    return end > new Date() ? new Date() : end;
  }

  const store = {
    get() { try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(POS_KEY, JSON.stringify(v)); } catch (e) { /* не критично */ } },
  };

  function clampFrom() {
    const n = +el.len.value;
    let f = el.from.value || addDays(today(), 1 - n);
    if (el.from.min && f < el.from.min) f = el.from.min;
    if (f > addDays(el.from.max, 1 - n)) f = addDays(el.from.max, 1 - n);
    el.from.value = f;
    el.prev.disabled = f <= el.from.min;
    el.next.disabled = addDays(f, n - 1) >= el.from.max;
  }

  // --- загрузка -------------------------------------------------------------
  async function fetchJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function loadIndex() {
    try {
      index = await fetchJson(`${base}index.json?t=${Date.now()}`);
    } catch (e) {
      index = null;        // архив ещё не опубликован — календарик не показываем
    }
    const days = index && index.days ? Object.keys(index.days).sort() : [];
    el.box.hidden = !days.length;
    if (!days.length) return;
    el.from.min = days[0];
    el.from.max = today() > days[days.length - 1] ? today() : days[days.length - 1];
    if (!el.from.value) {
      const saved = store.get();
      if (saved && saved.from) el.from.value = saved.from;
      if (saved && saved.len) el.len.value = String(saved.len);
    }
    clampFrom();
  }

  async function showPeriod() {
    if (!index) return;
    clampFrom();
    const password = L.password();
    if (!password) {
      App.showMsg('Сначала введите пароль для живых данных — архив зашифрован тем же паролем.', 'warn');
      return;
    }
    const n = +el.len.value;
    const days = Array.from({ length: n }, (_, i) => addDays(el.from.value, i));
    const span = n > 1 ? `${dm(days[0])}–${dm(days[n - 1])}` : dm(days[0]);
    store.set({ from: el.from.value, len: n });
    const have = days.filter(d => index.days[d]);
    const missing = days.filter(d => !index.days[d]);
    if (!have.length) {
      App.showMsg(`За ${span} в архиве ничего нет: задач не было или дни не загружены ` +
        '(догрузить на ПК со сборщиком: python tools/collector/collect.py --backfill ГГГГ-ММ-ДД).', 'warn');
      return;
    }
    el.show.disabled = true;
    let rows = [];
    try {
      const files = await Promise.all(have.map(d => fetchJson(`${base}${d}.json?t=${encodeURIComponent(index.updatedAt || '')}`)));
      for (const f of files) rows = rows.concat((await L.decrypt(f.enc, password)).rows);
    } catch (e) {
      console.error(e);
      App.showMsg(e.name === 'OperationError'
        ? 'Не удалось расшифровать архив — пароль не подходит. Введите его заново в строке живых данных.'
        : `Не удалось загрузить архив: ${e.message}`, 'error');
      return;
    } finally {
      el.show.disabled = false;
    }
    if (!rows.length) {
      App.showMsg(`За ${span} задач нет.`, 'warn');
      return;
    }
    const checked = have.map(d => index.days[d]).sort()[0];
    const label = `Архив Bitrix · ${span} · статусы на ${fmtAt(checked)}` +
      (missing.length ? ` · нет данных за ${missing.map(dm).join(', ')}` : '');
    App.loadRows(rows, `Архив Bitrix · ${span}`, periodNow(days[n - 1]), 'archive');
    App.showMsg('');
    L.onArchiveShown(label);
  }

  // --- события --------------------------------------------------------------
  const shift = k => { el.from.value = addDays(el.from.value, k); showPeriod(); };
  el.prev.addEventListener('click', () => shift(-1));
  el.next.addEventListener('click', () => shift(1));
  el.show.addEventListener('click', showPeriod);
  el.from.addEventListener('change', clampFrom);
  el.len.addEventListener('change', clampFrom);
  el.from.addEventListener('keydown', e => { if (e.key === 'Enter') showPeriod(); });

  loadIndex();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadIndex();
  });

  root.GanttArchive = { periodNow, reload: loadIndex };
})(window);
