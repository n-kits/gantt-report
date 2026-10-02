/*
 * Сводная таблица «Задачи и топонимы» под картой: задача, тема/тональность,
 * топонимы с макрорегионом, источником координат и расхождением с оценкой модели.
 * Сортировка — по колонке «Регистрация» (клик по заголовку), выбор запоминается.
 */
(function (root) {
  'use strict';

  const G = root.GanttGeo;
  const SORT_KEY = 'gantt-geo.sort';
  const SRC_LABEL = { cache: 'кэш', nominatim: 'Nominatim', llm: 'оценка модели', basemap: 'полигон страны' };
  const FAR_KM = 50;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* не критично */ } },
  };

  // Строки ленты (порядок Bitrix: название, статус, регистрация, …, проект, вид продукции) → по ID
  function rowsById(rows) {
    const out = {};
    for (const r of rows || []) {
      const m = /#(\d+)\s*$/.exec(String(r[0] || ''));
      if (m) out[m[1]] = r;
    }
    return out;
  }

  // geo.items + строки ленты → записи таблицы
  function fromLive(geo, rows) {
    const byId = rowsById(rows);
    return ((geo && geo.items) || []).map(it => {
      const r = byId[it.id] || [];
      return Object.assign({ name: r[0] || `#${it.id}`, project: r[6] || '', product: r[7] || '' }, it);
    });
  }

  function toponymHtml(t) {
    const src = t.src || '';
    const km = t.dkm != null ? ` <span class="km${t.dkm > FAR_KM ? ' far' : ''}">${t.dkm} км</span>` : '';
    const where = t.lat != null ? `${t.lat.toFixed(3)}, ${t.lon.toFixed(3)}` : (t.iso || '');
    return `<li><b>${esc(t.name)}</b> <span class="kind">${esc(t.kind)}</span>` +
      (t.macro ? ` · ${esc(t.macro)}` : '') +
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
      return `<tr><td class="id">${id}</td><td class="t">${esc(String(it.start || '').slice(0, 16))}</td>` +
        `<td><div class="nm">${esc(it.name)}</div><div class="meta">${esc(it.project)} · ${esc(it.product)}</div></td>` +
        `<td><div>${esc(meta)}</div><div class="meta">${esc(it.sentiment)}</div></td>` +
        `<td><ul>${tops || '<li class="miss">—</li>'}</ul></td></tr>`;
    }).join('');
    return `<table class="geo-tbl"><thead><tr><th>ID</th>` +
      `<th class="sortable" data-sort="start" title="Сортировать по времени регистрации">Регистрация ${arrow}</th>` +
      `<th>Задача</th><th>Тема / тональность</th><th>Топонимы</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  // Смонтировать таблицу в контейнер; повторный вызов — перерисовка с новыми данными
  function mount(box, items) {
    let dir = store.get(SORT_KEY) === 'desc' ? 'desc' : 'asc';
    box.innerHTML = render(items, dir);
    box.onclick = e => {
      if (!e.target.closest('th.sortable')) return;
      dir = dir === 'asc' ? 'desc' : 'asc';
      store.set(SORT_KEY, dir);
      box.innerHTML = render(items, dir);
    };
  }

  root.GanttGeoTable = { fromLive, render, mount, SRC_LABEL };
})(window);
