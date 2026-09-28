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
      out.push(`<th colspan="${g.to - g.from + 1}" style="background:${g.color}">${esc(g.label)}</th>`);
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
          out.push(`<td class="s on" style="background:${r.barColor}">${dl ? '◆' : ''}</td>`);
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

  // Отклонение от срока: меньше часа — в минутах, до суток — в часах,
  // больше суток — «X дн Y ч». null — меньше минуты.
  function fmtDelta(hours) {
    const min = Math.round(Math.abs(hours) * 60);
    if (min < 1) return null;
    if (min < 60) return `${min} мин`;
    if (min <= 24 * 60) return `${(min / 60).toFixed(1)} ч`;
    const totalH = Math.round(min / 60);
    return `${Math.floor(totalH / 24)} дн ${totalH % 24} ч`;
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
        <tr><th>Длительность</th><td>${t.durationH.toFixed(1)} ч</td></tr>
      </table>`;
  }

  root.GanttTimeline = { render, tooltipHtml };
})(window);
