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

  function render(tl) {
    const slotW = tl.step === 1 ? 24 : 30;
    const out = [];
    // точная ширина = сумма колонок: иначе длинные названия растягивают колонки
    // и закреплённая часть расходится со строками «Задача» / «Одновременно в работе»
    out.push(`<table class="tl" style="--slot-w:${slotW}px; --n-slots:${tl.nSlots}">`);

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
    out.push('<th class="fz fz1">ID</th><th class="fz fz2">Задача</th><th class="fz fz3">Исп.</th><th class="fz fz4">Статус</th>');
    for (const h of tl.hourHeads) out.push(`<th style="background:${h.color}">${h.label}</th>`);
    out.push('</tr></thead>');

    // Задачи
    out.push('<tbody>');
    tl.rows.forEach((r, ri) => {
      const t = r.task;
      out.push(`<tr class="task" data-i="${ri}">`);
      out.push(`<td class="fz fz1 id">${esc(t.id)}</td>`);
      out.push(`<td class="fz fz2 name">${esc(t.short)}</td>`);
      out.push(`<td class="fz fz3 exec" style="color:${r.execColor}">${esc(r.execShort)}</td>`);
      out.push(`<td class="fz fz4 status" style="color:${r.statusColor};background:${r.statusBg}">${esc(t.status)}</td>`);
      for (let h = 0; h < tl.nSlots; h++) {
        const on = r.startIdx != null && r.startIdx <= h && h <= r.endIdx;
        const dl = r.dlIdx === h;
        if (on) {
          // обводка «будущим» цветом: верх/низ у всех ячеек, бока — у первой и последней
          const ol = r.barOutline
            ? ` ol${h === r.startIdx ? ' ol-l' : ''}${h === r.endIdx ? ' ol-r' : ''}` : '';
          const olVar = r.barOutline ? `;--ol:${r.barOutline}` : '';
          out.push(`<td class="s on${ol}" style="background:${r.barColor};color:${r.barMark}${olVar}">${dl ? '◆' : ''}</td>`);
        } else if (dl) {
          out.push('<td class="s dl">◆</td>');
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
      <div class="tt-title">${t.id ? `#${esc(t.id)} ` : ''}${esc(t.name.replace(/\s*#[^#]*$/, ''))}</div>
      <table>
        <tr><th>Проект</th><td>${esc(t.project || '—')}</td></tr>
        <tr><th>Исполнитель</th><td>${esc(t.executor)}</td></tr>
        <tr><th>Вид продукции</th><td>${esc(t.product)}</td></tr>
        <tr><th>Статус</th><td><span class="tt-dot" style="background:${r.barColor}"></span>${esc(t.status)} ${note}</td></tr>
        <tr><th>Регистрация</th><td>${M.fmtFull(t.start)}</td></tr>
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

  root.GanttTimeline = { render, tooltipHtml, slotIndex, columnCells, fmtHours, fmtDelta };
})(window);
