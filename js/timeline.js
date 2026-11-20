/*
 * Рендер листа «Лента времени» в HTML-таблицу. Вся логика — в model.js,
 * здесь только разметка.
 */
(function (root) {
  'use strict';

  const M = root.GanttModel;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

  // свёрнутые головные задачи (номера): по умолчанию подзадачи раскрыты; помним до перезагрузки страницы
  const collapsed = new Set();

  // «Задача»: у головы — ▾/▸ (свернуть подзадачи), у подзадачи — «└» с отступом,
  // у подзадачи без головы на ленте — «↳»; кратность продукции — шильдик «×2»
  function nameCell(r) {
    const t = r.task;
    let pre = '';
    if (r.hasKids) {
      const c = collapsed.has(t.id);
      pre = `<button type="button" class="tree-t" data-id="${esc(t.id)}" aria-expanded="${!c}" title="${c ? 'Показать' : 'Скрыть'} подзадачи">${c ? '▸' : '▾'}</button>`;
    } else if (r.isChild) pre = '<span class="tree-l">└</span>';
    else if (t.headOut) pre = `<span class="tree-l" title="Подзадача; головная #${esc(t.parentId)} не на ленте">↳</span>`;
    const mult = t.mult > 1 ? `<span class="mult" title="Кратность продукции: ${t.mult}">×${t.mult}</span>` : '';
    return `${pre}${mult}${esc(t.short)}`;
  }

  // свернуть / раскрыть подзадачи головы — без перерисовки таблицы
  function toggleTree(table, id) {
    const c = !collapsed.has(id);
    if (c) collapsed.add(id); else collapsed.delete(id);
    table.querySelectorAll('tr.task.child').forEach(tr => { if (tr.dataset.head === id) tr.hidden = c; });
    const b = table.querySelector(`.tree-t[data-id="${CSS.escape(id)}"]`);
    if (b) { b.textContent = c ? '▸' : '▾'; b.setAttribute('aria-expanded', String(!c)); b.title = `${c ? 'Показать' : 'Скрыть'} подзадачи`; }
  }

  // ширина колонки «Исп.» — под самую длинную строку «Исполнитель / участник / …» (не уже 86 px)
  let measureCtx = null;
  function execWidth(rows) {
    if (typeof document === 'undefined') return 86;
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    const fam = getComputedStyle(document.body).fontFamily;
    const w = (font, s) => { measureCtx.font = font; return measureCtx.measureText(s).width; };
    const max = Math.max(0, ...rows.map(r => w(`700 11px ${fam}`, r.execShort) +
      (r.coExec.length ? w(`400 11px ${fam}`, ' / ' + r.coExec.join(' / ')) : 0)));
    return Math.max(86, Math.ceil(max) + 12);
  }

  function execCell(r) {
    const co = r.coExec.length ? `<span class="co"> / ${r.coExec.map(esc).join(' / ')}</span>` : '';
    return `<span style="color:${r.execColor}">${esc(r.execShort)}</span>${co}`;
  }

  // крайние ячейки полосы закрашены на ту долю часа, что задача в нём шла
  const MIN_PART = 0.12; // совсем короткий кусок всё равно виден

  // null — ячейка целиком; иначе [слева %, справа %] закрашенного куска
  function partOf(r, h) {
    let a = h === r.startIdx ? r.fromFrac : 0;
    let b = h === r.endIdx ? r.toFrac : 1;
    if (a <= 0 && b >= 1) return null;
    if (b - a < MIN_PART) {
      b = Math.min(1, a + MIN_PART);
      a = b - MIN_PART;
    }
    return [(a * 100).toFixed(1), ((1 - b) * 100).toFixed(1)];
  }

  // «◆» стоит в той минуте часа, на которую назначен срок, с вертикальной чертой
  // part — [слева %, справа %] заливки: «◆» вне неё — цветом срока, а не цветом метки полосы
  function dlMark(r, part) {
    // без сдвига: срок ровно в начале часа — ромб на границе ячеек, наполовину заходит в предыдущую
    const x = Math.max(0, Math.min(100, r.dlFrac * 100));
    const out = part && (x < +part[0] || x > 100 - part[1]);
    return `<span class="dlm" style="left:${x.toFixed(1)}%${out ? ';color:var(--accent)' : ''}"><i></i></span>`;
  }

  function render(tl) {
    const slotW = tl.step === 1 ? 24 : 30;
    const out = [];
    // точная ширина = сумма колонок: иначе длинные названия растягивают колонки
    // и закреплённая часть расходится со строками «Задача» / «Одновременно в работе»
    out.push(`<table class="tl" style="--slot-w:${slotW}px; --n-slots:${tl.nSlots}; --w-exec:${execWidth(tl.rows)}px">`);

    out.push('<colgroup><col class="c-id"><col class="c-name"><col class="c-exec"><col class="c-status">');
    for (let i = 0; i < tl.nSlots; i++) out.push('<col class="c-slot">');
    out.push('</colgroup>');

    // Шапка: даты и часы
    out.push('<thead><tr class="h-days">');
    out.push('<th class="fz fz-all" colspan="4">Задача</th>');
    for (const g of tl.dayGroups) {
      const text = g.weekday ? `${g.weekday}, ${g.label}` : g.label;
      out.push(`<th colspan="${g.to - g.from + 1}" style="background:${g.color}">${esc(text)}</th>`);
    }
    out.push('</tr><tr class="h-hours">');
    out.push('<th class="fz fz1">ID</th><th class="fz fz2">Задача</th><th class="fz fz3">Исполнители</th><th class="fz fz4">Статус</th>');
    for (const h of tl.hourHeads) out.push(`<th style="background:${h.color}">${h.label}</th>`);
    out.push('</tr></thead>');

    // Задачи
    out.push('<tbody>');
    tl.rows.forEach((r, ri) => {
      const t = r.task;
      const child = r.isChild ? ` child" data-head="${esc(r.head)}"${collapsed.has(r.head) ? ' hidden' : ''}` : '"';
      out.push(`<tr class="task${r.hasKids ? ' head' : ''}${child} data-i="${ri}">`);
      const url = M.taskUrl(t.id);
      out.push(`<td class="fz fz1 id">${url ? `<a class="task-link" href="${esc(url)}" target="_blank" rel="noopener" title="Открыть в Bitrix">${esc(t.id)}</a>` : esc(t.id)}</td>`);
      out.push(`<td class="fz fz2 name${r.isChild ? ' sub' : ''}">${nameCell(r)}</td>`);
      out.push(`<td class="fz fz3 exec">${execCell(r)}</td>`);
      out.push(`<td class="fz fz4 status" style="color:${r.statusColor};background:${r.statusBg}">${esc(t.status)}</td>`);
      for (let h = 0; h < tl.nSlots; h++) {
        const on = r.startIdx != null && r.startIdx <= h && h <= r.endIdx;
        const dl = r.dlIdx === h;
        if (on) {
          // обводка «будущим» цветом: верх/низ у всех ячеек, бока — у первой и последней
          const ol = r.barOutline
            ? ` ol${h === r.startIdx ? ' ol-l' : ''}${h === r.endIdx ? ' ol-r' : ''}` : '';
          const olVar = r.barOutline ? `;--ol:${r.barOutline}` : '';
          // задача с прошлых дней: полоса уходит за левый край — стрелка в первой ячейке
          const cut = r.cutLeft && h === r.startIdx;
          const part = partOf(r, h);
          const st = part
            ? `--bar:${r.barColor};--pl:${part[0]}%;--pr:${part[1]}%;color:${r.barMark}${olVar}`
            : `background:${r.barColor};color:${r.barMark}${olVar}`;
          const mark = dl ? dlMark(r, part) : cut ? '←' : '';
          out.push(`<td class="s on${ol}${cut ? ' cut-l' : ''}${part ? ' part' : ''}${dl ? ' dlx' : ''}" style="${st}">${mark}</td>`);
        } else if (dl) {
          out.push(`<td class="s dl dlx">${dlMark(r)}</td>`);
        } else {
          out.push('<td class="s"></td>');
        }
      }
      out.push('</tr>');
    });

    // Пустая строка, затем «Одновременно в работе» — закреплена внизу (tfoot, sticky)
    out.push(`<tr class="gap"><td class="fz fz-all" colspan="4"></td><td colspan="${tl.nSlots}"></td></tr>`);
    out.push('</tbody><tfoot><tr class="cap"><td class="fz fz-all" colspan="4">Одновременно в работе</td>');
    for (const c of tl.capacity) {
      out.push(`<td style="background:${c.color};color:${c.textColor}">${c.count}</td>`);
    }
    out.push('</tr></tfoot></table>');
    return out.join('');
  }

  // Часы: до суток — «N.N ч», больше суток — «X дн Y ч»
  function fmtHours(hours) {
    const h = Math.abs(hours);
    if (h <= 24) return `${h.toFixed(1)} ч`;
    const totalH = Math.round(h);
    return `${Math.floor(totalH / 24)} дн ${totalH % 24} ч`;
  }

  // Отклонение от срока: меньше часа — в минутах, дальше — как fmtHours. null — меньше минуты.
  function fmtDelta(hours) {
    const min = Math.round(Math.abs(hours) * 60);
    if (min < 1) return null;
    if (min < 60) return `${min} мин`;
    return fmtHours(min / 60);
  }

  function tooltipHtml(r) {
    const t = r.task;
    let note = '';
    if (t.late) {
      const d = t.delayH != null ? fmtDelta(t.delayH) : '';
      note = `<span class="tt-late">срок нарушен${d ? ` на ${d}` : d === null ? ' меньше чем на минуту' : ''}</span>`;
    } else if (t.finish && t.delayH != null) {
      const d = fmtDelta(t.delayH);
      note = `<span class="tt-early">${d ? `раньше срока на ${d}` : 'точно в срок'}</span>`;
    }
    const finish = t.finish ? M.fmtFull(t.finish) : '— (не завершена)';
    return `
      <div class="tt-title">${t.id ? `#${esc(t.id)} ` : ''}${esc(M.stripId(t.name))}</div>
      <table>
        <tr><th>Проект</th><td>${esc(t.project || '—')}</td></tr>
        <tr><th>Исполнитель</th><td>${esc(t.executor)}</td></tr>
        ${r.people.length > 1 || r.coExec.length ? `<tr><th>Участники</th><td>${r.people.map(p => `${esc(p.name)}${p.at ? ` <span class="tt-at">${M.fmtDMHM(p.at)}</span>` : ''}`).join('<br>')}</td></tr>` : ''}
        <tr><th>Вид продукции</th><td>${esc(t.product)}${t.mult > 1 ? ` <span class="mult">×${t.mult}</span>` : ''}</td></tr>
        ${t.isChild ? `<tr><th>Головная</th><td>#${esc(t.head)} — одна единица продукции</td></tr>` : ''}
        ${t.headOut ? `<tr><th>Головная</th><td>#${esc(t.parentId)} — не на ленте</td></tr>` : ''}
        ${t.kids.length ? `<tr><th>Подзадачи</th><td>${t.kids.map(k => '#' + esc(k)).join(', ')}</td></tr>` : ''}
        ${t.checker ? `<tr><th>Проверяющий</th><td>${esc(t.checker)}</td></tr>` : ''}
        <tr><th>Статус</th><td><span class="tt-dot" style="background:${r.barColor}"></span>${esc(t.status)} ${note}</td></tr>
        <tr><th>Регистрация</th><td>${M.fmtFull(t.start)}${r.cutLeft ? ' <span class="tt-carry">раньше окна ленты — тянется в него</span>' : ''}</td></tr>
        <tr><th>Завершение</th><td>${finish}</td></tr>
        <tr><th>Крайний срок</th><td>${M.fmtFull(t.deadline)}</td></tr>
        <tr><th>Длительность</th><td>${fmtHours(t.durationH)}</td></tr>
      </table>`;
  }

  // Индекс часовой колонки под ячейкой (или null): в шапке часов и строках задач
  // перед часами 4 закреплённые ячейки, в строке «Одновременно в работе» — одна.
  function slotIndex(cell) {
    const tr = cell && cell.parentElement;
    if (!tr) return null;
    let i = null;
    if (tr.classList.contains('h-hours') || tr.classList.contains('task')) i = cell.cellIndex - 4;
    else if (tr.classList.contains('cap')) i = cell.cellIndex - 1;
    return i != null && i >= 0 ? i : null;
  }

  // Все ячейки часовой колонки i: час в шапке, ячейки задач, итог внизу.
  function columnCells(table, i) {
    const out = [];
    for (const tr of table.querySelectorAll('tr.h-hours, tr.task')) out.push(tr.cells[i + 4]);
    const cap = table.querySelector('tr.cap');
    if (cap) out.push(cap.cells[i + 1]);
    return out.filter(Boolean);
  }

  root.GanttTimeline = { render, tooltipHtml, slotIndex, columnCells, fmtHours, fmtDelta, toggleTree };
})(window);
