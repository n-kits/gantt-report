/*
 * Сводная таблица «Задачи и топонимы» под картой: задача, тема/тональность,
 * топонимы с макрорегионом, источником координат и расхождением с оценкой модели.
 * Сортировка — по колонке «Регистрация» (клик по заголовку), выбор запоминается.
 */
(function (root) {
  'use strict';

  const G = root.GanttGeo;
  const SORT_KEY = 'gantt-geo.sort';
  const OPEN_KEY = 'gantt-geo.table-open';   // '1' — развёрнута; по умолчанию свёрнута
  const SRC_LABEL = { cache: 'кэш', nominatim: 'Nominatim', llm: 'оценка модели', basemap: 'полигон страны', manual: 'вручную' };
  const FAR_KM = 50;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* не критично */ } },
  };

  // номер задачи из названия «… #1234567 …» (как в ленте, GanttModel.extractId)
  const idOf = name => (root.GanttModel ? root.GanttModel.extractId(name)
    : ((/#(\d+)(?![\s\S]*#\d)/.exec(String(name || '')) || [])[1] || ''));

  // Все задачи ленты (порядок Bitrix: название, статус, регистрация, …, проект, вид продукции) + geo.items.
  // Задача без анализа LLM (ещё не разобрана, не удалось) — тоже строка, с пометкой pending.
  function fromLive(geo, rows) {
    const byId = {};
    for (const it of (geo && geo.items) || []) byId[it.id] = it;
    const out = [], seen = new Set();
    for (const r of rows || []) {
      const id = idOf(r[0]);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const base = { id, name: r[0] || `#${id}`, start: r[2] || '', project: r[6] || '', product: r[7] || '' };
      out.push(byId[id] ? Object.assign(base, byId[id]) : Object.assign(base, { pending: true }));
    }
    for (const it of (geo && geo.items) || []) {          // анализ есть, а строки в ленте нет — всё равно показать
      if (!seen.has(it.id)) out.push(Object.assign({ name: `#${it.id}`, project: '', product: '' }, it));
    }
    return out;
  }

  function toponymHtml(t) {
    const src = t.src || '';
    const km = t.dkm != null ? ` <span class="km${t.dkm > FAR_KM ? ' far' : ''}">${t.dkm} км</span>` : '';
    const where = t.lat != null ? `${t.lat.toFixed(3)}, ${t.lon.toFixed(3)}` : (t.iso || '');
    // регион и страна — по координатам (сборщик, places.py); в старых данных — как назвала LLM
    const place = t.pid ? [t.region, t.kind === 'country' ? '' : t.country].filter(Boolean).join(', ') : t.macro;
    return `<li><b>${esc(t.name)}</b> <span class="kind">${esc(t.kind)}</span>` +
      (place ? ` · ${esc(place)}` : '') +
      (src ? ` <span class="src ${esc(src)}">${esc(SRC_LABEL[src] || src)}</span>` : '') +
      `${km} <span class="coord">${esc(where)}</span></li>`;
  }

  function render(items, dir) {
    const time = it => { const d = G.parseStart(it.start); return d ? d.getTime() : 0; };
    const sorted = items.slice().sort((a, b) => (time(a) - time(b)) * (dir === 'desc' ? -1 : 1));
    const arrow = dir === 'desc' ? '▼' : '▲';
    const body = sorted.map(it => {
      const meta = (it.themes || []).join(' / ') + (it.conflict ? ` · ${it.conflict}` : '');
      const tops = (it.toponyms || []).map(toponymHtml).join('');
      const url = root.GanttModel && root.GanttModel.taskUrl(it.id);
      const id = url ? `<a class="task-link" href="${esc(url)}" target="_blank" rel="noopener" title="Открыть в Bitrix">${esc(it.id)}</a>` : esc(it.id);
      const analysis = it.pending
        ? '<td colspan="2" class="pending-note">анализа пока нет — тема, тональность и топонимы появятся после разбора</td>'
        : `<td><div>${esc(meta)}</div><div class="meta">${esc(it.sentiment)}</div></td>` +
          `<td><ul>${tops || '<li class="miss">—</li>'}</ul></td>`;
      return `<tr${it.pending ? ' class="pending" title="Задачу ещё не разобрала модель"' : ''}><td class="id">${id}</td><td class="t">${esc(String(it.start || '').slice(0, 16))}</td>` +
        `<td><div class="nm">${esc(it.name)}</div><div class="meta">${esc(it.project)} · ${esc(it.product)}</div></td>` +
        `${analysis}</tr>`;
    }).join('');
    return `<table class="geo-tbl"><thead><tr><th>ID</th>` +
      `<th class="sortable" data-sort="start" title="Сортировать по времени регистрации">Регистрация ${arrow}</th>` +
      `<th>Задача</th><th>Тема / тональность</th><th>Топонимы</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  // Смонтировать таблицу в контейнер; повторный вызов — перерисовка с новыми данными
  function mount(box, items) {
    const count = document.getElementById('geo-table-count');
    const pending = items.filter(it => it.pending).length;
    if (count) {
      count.textContent = pending ? `${items.length} · без анализа ${pending}` : items.length;
      count.title = pending ? 'Задачи, которые модель ещё не разобрала, подсвечены в таблице' : '';
    }
    let dir = store.get(SORT_KEY) === 'desc' ? 'desc' : 'asc';
    box.innerHTML = render(items, dir);
    box.onclick = e => {
      if (!e.target.closest('th.sortable')) return;
      dir = dir === 'asc' ? 'desc' : 'asc';
      store.set(SORT_KEY, dir);
      box.innerHTML = render(items, dir);
    };
  }

  // свернуть / развернуть: в свёрнутом виде виден только заголовок с числом задач
  const toggle = document.getElementById('geo-table-toggle');
  const body = document.getElementById('geo-table-body');
  function setOpen(open) {
    if (!toggle || !body) return;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? 'Свернуть таблицу' : 'Развернуть таблицу';
  }
  if (toggle) {
    setOpen(store.get(OPEN_KEY) === '1');
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      store.set(OPEN_KEY, open ? '1' : '0');
      setOpen(open);
    });
  }

  root.GanttGeoTable = { fromLive, render, mount, setOpen, SRC_LABEL };
})(window);
