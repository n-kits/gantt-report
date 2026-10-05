/*
 * Вкладка «Аналитика»: графики дашборда (SVG строкой, без библиотек) и общие элементы — подсказка, таблица-дубль.
 * Каждый график — функция (ctx): ctx.M — модель (data.js), ctx.st — фильтры, ctx.list — заказы после фильтров,
 * ctx.$(id) — элемент #an-<id>, ctx.update(patch) — поменять фильтры и перерисовать.
 */
(function (root) {
  'use strict';

  const A = root.GanttAnalytics;
  const { fmtN, fmt1, fmtPct, fmtH, plural, dm, dmy, dmhm, esc, addDays, span, median, countBy } = A.util;
  const PRODUCTS = A.PRODUCTS, HOUR = A.HOUR;

  // --- общие элементы -------------------------------------------------------
  let tip = null;
  function showTip(e, html) {
    if (!tip) tip = document.getElementById('an-tip');
    tip.innerHTML = html; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + w > innerWidth - 8) x = e.clientX - w - 14;
    if (y + h > innerHeight - 8) y = e.clientY - h - 14;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
  }
  const hideTip = () => { if (tip) tip.hidden = true; };
  const row = (sw, label, val) => `<div class="r"><span>${sw ? `<span class="sw" style="background:${sw}"></span>` : ''}${esc(label)}</span><b>${val}</b></div>`;
  function bindHits(el, items, html, onClick) {
    el.querySelectorAll('[data-i]').forEach(n => {
      const it = items[+n.dataset.i];
      n.addEventListener('mousemove', e => showTip(e, html(it)));
      n.addEventListener('mouseleave', hideTip);
      if (onClick) n.addEventListener('click', () => { hideTip(); onClick(it); });
    });
  }
  const table = (head, rows) => `<table><thead><tr>${head.map((h, i) => `<th class="${i ? 'n' : ''}">${esc(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'n' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

  // скруглённый на конце столбик: 4px со стороны данных, прямой у основания
  function colPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function barPath(x, y, w, h, r) {
    r = Math.min(r, h / 2, w);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  }
  const widthOf = el => Math.max(260, el.clientWidth);
  // круглые деления оси: шаг 1/2/5×10^k, 3–5 делений
  function ticks(v) {
    const raw = Math.max(1, v) / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = Math.max(1, [1, 2, 5, 10].map(m => m * p).find(x => x >= raw));
    const top = Math.max(step, Math.ceil(Math.max(1, v) / step) * step);
    const out = []; for (let t = 0; t <= top + 1e-9; t += step) out.push(t);
    return { top, list: out };
  }
  function yAxis(tk, y, L, W, R) {
    return tk.list.map((v, k) => {
      const yy = Math.round(y(v)) + .5;
      return `<line class="${k ? 'gridline' : 'baseline'}" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${fmtN(v)}</text>`;
    }).join('');
  }

  // --- горизонтальные столбики ----------------------------------------------
  function hbars(el, items, opts) {
    opts = opts || {};
    if (!items.length) { el.innerHTML = '<div class="an-empty">Нет данных за период</div>'; return; }
    const W = widthOf(el), rowH = 26, bh = 16, labelW = Math.min(opts.labelW || 190, W * 0.46), valW = 44;
    const H = items.length * rowH + 4;
    const max = Math.max(1, ...items.map(it => it.value));
    const x = v => (W - labelW - valW) * v / max;
    let s = `<line class="baseline" x1="${labelW}" x2="${labelW}" y1="0" y2="${H}"/>`;
    items.forEach((it, i) => {
      const yy = i * rowH + 4, w = Math.max(1, x(it.value));
      const dim = opts.active && opts.active !== it.key ? ' class="dim"' : '';
      const label = it.label.length > 30 ? it.label.slice(0, 29) + '…' : it.label;
      s += `<g${dim}><text class="lbl" x="${labelW - 8}" y="${yy + bh / 2 + 4}" text-anchor="end">${esc(label)}</text>` +
        `<path d="${barPath(labelW, yy, w, bh, 4)}" fill="${it.color || 'var(--an-s1)'}"/>` +
        `<text class="val" x="${labelW + w + 6}" y="${yy + bh / 2 + 4}">${opts.fmt ? opts.fmt(it.value) : fmtN(it.value)}</text></g>` +
        `<rect class="hit${opts.onClick ? ' click' : ''}" data-i="${i}" x="0" y="${yy - 5}" width="${W}" height="${rowH}"/>`;
    });
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(opts.title || '')}">${s}</svg>`;
    bindHits(el, items, opts.tip || (it => `<div class="t">${esc(it.label)}</div>${row('', 'Заказов', fmtN(it.value))}`), opts.onClick);
  }

  function topN(map, n, otherLabel) {
    const arr = [...map.entries()].map(([key, v]) => ({ key, label: key, value: v })).sort((a, b) => b.value - a.value);
    if (arr.length <= n) return arr;
    const rest = arr.slice(n - 1);
    return [...arr.slice(0, n - 1), { key: '', label: `${otherLabel} (${rest.length})`, value: rest.reduce((a, x) => a + x.value, 0), other: true }];
  }

  // === Поток ================================================================
  function kpis(ctx) {
    const { M, st, list } = ctx;
    const n = list.length, days = span(st.from, st.to);
    const prevTo = addDays(st.from, -1), prevFrom = addDays(st.from, -days);
    const prev = prevFrom >= M.firstDay ? M.tasks.filter(t => A.inRange(t, prevFrom, prevTo) && A.byDims(st)(t)).length : null;
    let delta = 'нет данных за предыдущий такой же период';
    if (prev != null && prev > 0) {
      const d = (n - prev) / prev;
      delta = `<b>${d >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(d * 100))}%</b> к ${dm(prevFrom)}–${dm(prevTo)} (${fmtN(prev)})`;
    }
    const sla = list.filter(t => t.onTime != null), ok = sla.filter(t => t.onTime).length;
    const leads = list.map(t => t.lead).filter(v => v != null);
    const team = list.filter(t => t.workers.length >= 2).length;
    ctx.$('kpis').innerHTML = [
      `<div class="kpi hero"><div class="label">Заказов за период</div><div class="value">${fmtN(n)}</div><div class="delta">${delta}</div></div>`,
      `<div class="kpi"><div class="label">В срок</div><div class="value">${fmtPct(sla.length ? ok / sla.length : null)}</div>` +
        `<div class="delta">с нарушением — ${fmtN(sla.length - ok)} из ${fmtN(sla.length)}</div></div>`,
      `<div class="kpi"><div class="label">Медиана выполнения</div><div class="value">${fmtH(median(leads))}</div>` +
        `<div class="delta">от регистрации до завершения</div></div>`,
      `<div class="kpi"><div class="label">В среднем за день</div><div class="value">${fmt1(n / days)}</div>` +
        `<div class="delta">за ${fmtN(days)} дн.</div></div>`,
      `<div class="kpi"><div class="label">Совместные</div><div class="value">${fmtPct(n ? team / n : null)}</div>` +
        `<div class="delta">2 и больше исполнителей</div></div>`,
    ].join('');
  }

  // заказы по дням: столбики с разбивкой по видам продукции; в подсказке — когда сверены статусы дня
  function days(ctx) {
    const { M, st, list } = ctx;
    const el = ctx.$('days');
    const ds = []; for (let d = st.from; d <= st.to; d = addDays(d, 1)) ds.push(d);
    const shown = PRODUCTS.filter(p => !st.product || p.key === st.product);
    const by = ds.map(d => { const o = { day: d, total: 0 }; PRODUCTS.forEach(p => { o[p.key] = 0; }); return o; });
    const idx = Object.fromEntries(ds.map((d, i) => [d, i]));
    list.forEach(t => { const o = by[idx[t.day]]; if (o) { o[t.pkey]++; o.total++; } });

    ctx.$('days-legend').innerHTML = PRODUCTS.map(p =>
      `<button type="button" data-p="${p.key}" aria-pressed="${!st.product || st.product === p.key}"><span class="sw" style="background:${p.color}"></span>${p.label}</button>`).join('');
    ctx.$('days-legend').querySelectorAll('button').forEach(b => b.addEventListener('click', () =>
      ctx.update({ product: st.product === b.dataset.p ? '' : b.dataset.p })));

    const W = widthOf(el), H = 240, L = 34, R = 8, T = 10, B = 26;
    const tk = ticks(Math.max(...by.map(o => o.total))), max = tk.top;
    const band = (W - L - R) / ds.length, bw = Math.min(24, Math.max(3, band * 0.7));
    const y = v => T + (H - T - B) * (1 - v / max);
    let s = yAxis(tk, y, L, W, R);
    const every = Math.max(1, Math.ceil(ds.length / Math.floor((W - L) / 46)));
    by.forEach((o, i) => {
      const x = L + band * i + (band - bw) / 2;
      let acc = 0;
      const segs = shown.filter(p => o[p.key]);
      segs.forEach((p, j) => {
        const y0 = y(acc), y1 = y(acc + o[p.key]);
        const gap = j < segs.length - 1 ? 2 : 0;           // 2px зазор цвета фона между сегментами
        const h = Math.max(0, y0 - y1);
        s += j === segs.length - 1 ? `<path d="${colPath(x, y1, bw, h, 4)}" fill="${p.color}"/>`
          : `<rect x="${x}" y="${y1 + gap}" width="${bw}" height="${Math.max(0, h - gap)}" fill="${p.color}"/>`;
        acc += o[p.key];
      });
      if (i % every === 0) {
        const wd = new Date(o.day + 'T12:00').getDay();
        s += `<text x="${L + band * i + band / 2}" y="${H - 8}" text-anchor="middle"${wd === 0 || wd === 6 ? ' style="font-weight:600"' : ''}>${dm(o.day)}</text>`;
      }
      s += `<rect class="hit" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}"/>`;
    });
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Заказы по дням">${s}</svg>`;
    bindHits(el, by, o => {
      const wd = new Date(o.day + 'T12:00').toLocaleDateString('ru-RU', { weekday: 'long' });
      return `<div class="t">${dmy(o.day)}, ${wd}</div>` + shown.filter(p => o[p.key]).reverse().map(p => row(p.color, p.label, fmtN(o[p.key]))).join('') +
        row('', 'Всего', fmtN(shown.reduce((a, p) => a + o[p.key], 0))) +
        (M.checked[o.day] ? `<div class="g">статусы на ${dmhm(M.checked[o.day])}</div>` : '');
    });
    ctx.$('days-t').innerHTML = table(['День', ...shown.map(p => p.label), 'Всего', 'Статусы на'],
      by.map(o => [dmy(o.day), ...shown.map(p => o[p.key]), shown.reduce((a, p) => a + o[p.key], 0), dmhm(M.checked[o.day])]));
  }

  function projects(ctx) {
    const { M, st } = ctx;
    // проекты — без фильтра по проекту, чтобы видеть выбранный среди остальных
    const list = M.tasks.filter(t => A.inRange(t, st.from, st.to) && (!st.product || t.pkey === st.product));
    const items = topN(countBy(list, t => t.project), 9, 'Другие').map(it => Object.assign(it, { color: it.other ? 'var(--an-other)' : 'var(--an-s1)' }));
    hbars(ctx.$('projects'), items, {
      title: 'Проекты', active: st.project, labelW: 170,
      onClick: it => { if (!it.other) ctx.update({ project: st.project === it.key ? '' : it.key }); },
    });
    ctx.$('projects-t').innerHTML = table(['Проект', 'Заказов'], [...countBy(list, t => t.project).entries()].sort((a, b) => b[1] - a[1]));
  }

  // тепловая карта: день недели × час регистрации
  function heat(ctx) {
    const el = ctx.$('heat');
    const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const m = WD.map(() => new Array(24).fill(0));
    ctx.list.forEach(t => { if (t.startD) m[(t.startD.getDay() + 6) % 7][t.startD.getHours()]++; });
    const max = Math.max(1, ...m.flat());
    const W = widthOf(el), L = 26, T = 4, B = 20, cw = (W - L) / 24, ch = Math.min(26, cw * 1.1), H = T + ch * 7 + B;
    let s = '';
    const items = [];
    m.forEach((r, d) => r.forEach((v, h) => {
      const i = items.push({ d, h, v }) - 1;
      const op = v ? 0.12 + 0.88 * v / max : 0;
      s += `<rect x="${L + h * cw + 1}" y="${T + d * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" ` +
        `fill="${v ? 'var(--an-seq)' : 'var(--an-grid)'}" fill-opacity="${v ? op.toFixed(3) : 0.6}"/>` +
        `<rect class="hit" data-i="${i}" x="${L + h * cw}" y="${T + d * ch}" width="${cw}" height="${ch}"/>`;
    }));
    WD.forEach((w, d) => { s += `<text x="${L - 6}" y="${T + d * ch + ch / 2 + 4}" text-anchor="end">${w}</text>`; });
    for (let h = 0; h < 24; h += 3) s += `<text x="${L + h * cw + cw / 2}" y="${H - 6}" text-anchor="middle">${String(h).padStart(2, '0')}</text>`;
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Регистрации по дню недели и часу">${s}</svg>`;
    bindHits(el, items, it => `<div class="t">${WD[it.d]}, ${String(it.h).padStart(2, '0')}:00–${String(it.h + 1).padStart(2, '0')}:00</div>${row('', 'Заказов', fmtN(it.v))}`);
    ctx.$('heat-t').innerHTML = table(['Час', ...WD], Array.from({ length: 24 }, (_, h) => [String(h).padStart(2, '0') + ':00', ...WD.map((_, d) => m[d][h])]));
  }

  // === Сроки ================================================================
  const LEAD_BINS = [[0, 1, 'до 1 ч'], [1, 2, '1–2 ч'], [2, 3, '2–3 ч'], [3, 5, '3–5 ч'], [5, 8, '5–8 ч'], [8, 24, '8–24 ч'], [24, Infinity, 'больше суток']];
  function lead(ctx) {
    const el = ctx.$('lead');
    const leads = ctx.list.filter(t => t.lead != null);
    const bins = LEAD_BINS.map(([a, b, label]) => {
      const inBin = leads.filter(t => t.lead >= a && t.lead < b);
      const sla = inBin.filter(t => t.onTime != null);
      return { label, value: inBin.length, ok: sla.filter(t => t.onTime).length, sla: sla.length };
    });
    if (!leads.length) { el.innerHTML = '<div class="an-empty">Нет завершённых заказов</div>'; ctx.$('lead-t').innerHTML = ''; return; }
    const W = widthOf(el), H = 220, L = 34, R = 8, T = 18, B = 26;
    const tk = ticks(Math.max(...bins.map(b => b.value))), max = tk.top;
    const band = (W - L - R) / bins.length, bw = Math.min(24, band * 0.62);
    const y = v => T + (H - T - B) * (1 - v / max);
    let s = yAxis(tk, y, L, W, R);
    bins.forEach((b, i) => {
      const x = L + band * i + (band - bw) / 2, yy = y(b.value);
      if (b.value) s += `<path d="${colPath(x, yy, bw, y(0) - yy, 4)}" fill="var(--an-s1)"/><text class="val" x="${x + bw / 2}" y="${yy - 5}" text-anchor="middle">${fmtN(b.value)}</text>`;
      s += `<text x="${L + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${b.label}</text>` +
        `<rect class="hit" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}"/>`;
    });
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Время выполнения">${s}</svg>` +
      `<div class="an-cap">Медиана — ${fmtH(median(leads.map(t => t.lead)))}; завершённых — ${fmtN(leads.length)}.</div>`;
    bindHits(el, bins, b => `<div class="t">${b.label}</div>${row('', 'Заказов', fmtN(b.value))}${row('', 'Из них в срок', b.sla ? fmtPct(b.ok / b.sla) : '—')}`);
    ctx.$('lead-t').innerHTML = table(['Время', 'Заказов', 'В срок'], bins.map(b => [b.label, b.value, b.sla ? fmtPct(b.ok / b.sla) : '—']));
  }

  function sla(ctx) {
    const el = ctx.$('sla');
    const rows = PRODUCTS.map(p => {
      const s = ctx.list.filter(t => t.pkey === p.key && t.onTime != null);
      return { p, ok: s.filter(t => t.onTime).length, bad: s.filter(t => !t.onTime).length };
    }).filter(r => r.ok + r.bad);
    if (!rows.length) { el.innerHTML = '<div class="an-empty">Нет завершённых заказов с крайним сроком</div>'; ctx.$('sla-t').innerHTML = ''; return; }
    const W = widthOf(el), rowH = 34, bh = 18, labelW = Math.min(170, W * 0.4), H = rows.length * rowH;
    const bw = W - labelW - 8;
    let s = '';
    rows.forEach((r, i) => {
      const n = r.ok + r.bad, yy = i * rowH + 6, wOk = bw * r.ok / n, gap = r.ok && r.bad ? 2 : 0;
      s += `<text class="lbl" x="${labelW - 8}" y="${yy + bh / 2 + 4}" text-anchor="end">${esc(r.p.label)}</text>`;
      if (r.ok) s += r.bad ? `<rect x="${labelW}" y="${yy}" width="${wOk}" height="${bh}" fill="var(--an-good)"/>` : `<path d="${barPath(labelW, yy, wOk, bh, 4)}" fill="var(--an-good)"/>`;
      if (r.bad) s += `<path d="${barPath(labelW + wOk + gap, yy, bw - wOk - gap, bh, 4)}" fill="var(--an-critical)"/>`;
      if (wOk > 64) s += `<text x="${labelW + 8}" y="${yy + bh / 2 + 4}" style="fill:#fff;font-weight:600">✓ ${Math.round(100 * r.ok / n)}%</text>`;
      s += `<rect class="hit" data-i="${i}" x="0" y="${yy - 6}" width="${W}" height="${rowH}"/>`;
    });
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Соблюдение срока по видам продукции">${s}</svg>`;
    bindHits(el, rows, r => `<div class="t">${esc(r.p.label)}</div>${row('var(--an-good)', '✓ В срок', `${fmtN(r.ok)} · ${fmtPct(r.ok / (r.ok + r.bad))}`)}${row('var(--an-critical)', '! С нарушением', `${fmtN(r.bad)} · ${fmtPct(r.bad / (r.ok + r.bad))}`)}`);
    ctx.$('sla-t').innerHTML = table(['Вид продукции', 'В срок', 'С нарушением', 'Доля в срок'], rows.map(r => [r.p.label, r.ok, r.bad, fmtPct(r.ok / (r.ok + r.bad))]));
  }

  // запас и опоздание: слева — раньше срока, справа — позже, как на оси времени
  const MARGIN_BINS = [[0, 0.25, 'до 15 мин'], [0.25, 0.5, '15–30 мин'], [0.5, 1, '30 мин–1 ч'], [1, 2, '1–2 ч'],
                       [2, 4, '2–4 ч'], [4, 8, '4–8 ч'], [8, 24, '8–24 ч'], [24, Infinity, 'больше суток']];
  const marginOf = t => (t.onTime != null ? (t.deadlineD - t.finishD) / HOUR : null);   // > 0 — раньше срока
  function margin(ctx) {
    const { list } = ctx;
    const el = ctx.$('margin');
    const ms = list.map(marginOf).filter(v => v != null);
    const early = ms.filter(v => v >= 0), late = ms.filter(v => v < 0).map(v => -v);
    const q = (a, k) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * k))]; };
    ctx.$('margin-kpis').innerHTML = [
      `<div class="kpi"><div class="label">Раньше срока</div><div class="value">${fmtN(early.length)}</div><div class="delta">${fmtPct(ms.length ? early.length / ms.length : null)} заказов с крайним сроком</div></div>`,
      `<div class="kpi"><div class="label">Запас, медиана</div><div class="value">${fmtH(median(early))}</div><div class="delta">у 90% — меньше ${fmtH(q(early, 0.9))}</div></div>`,
      `<div class="kpi"><div class="label">Позже срока</div><div class="value">${fmtN(late.length)}</div><div class="delta">${fmtPct(ms.length ? late.length / ms.length : null)} заказов с крайним сроком</div></div>`,
      `<div class="kpi"><div class="label">Опоздание, медиана</div><div class="value">${fmtH(median(late))}</div><div class="delta">у 10% — больше ${fmtH(q(late, 0.9))}, максимум ${fmtH(late.length ? Math.max(...late) : null)}</div></div>`,
    ].join('');
    if (!ms.length) { el.innerHTML = '<div class="an-empty">Нет завершённых заказов с крайним сроком</div>'; ctx.$('margin-t').innerHTML = ''; return; }
    const nb = MARGIN_BINS.length;
    const cols = [
      ...MARGIN_BINS.map(([a, b, label], i) => ({ side: 'early', i, label, value: early.filter(v => v >= a && v < b).length })).reverse(),
      ...MARGIN_BINS.map(([a, b, label], i) => ({ side: 'late', i, label, value: late.filter(v => v > a && v <= b).length })),
    ];
    const W = widthOf(el), H = 230, L = 34, R = 8, T = 18, B = 40;
    const tk = ticks(Math.max(...cols.map(c => c.value))), max = tk.top;
    const band = (W - L - R) / cols.length, bw = Math.min(24, band * 0.7);
    const y = v => T + (H - T - B) * (1 - v / max);
    let s = yAxis(tk, y, L, W, R);
    const mid = L + band * nb;
    s += `<line x1="${mid}" x2="${mid}" y1="${T - 8}" y2="${H - B}" stroke="var(--an-ink-2)" stroke-width="1"/>` +
      `<text class="lbl" x="${mid}" y="${T - 10}" text-anchor="middle">крайний срок</text>`;
    cols.forEach((c, k) => {
      const x = L + band * k + (band - bw) / 2, yy = y(c.value);
      const op = (0.4 + 0.6 * c.i / (nb - 1)).toFixed(2);      // дальше от срока — насыщеннее
      if (c.value) s += `<path d="${colPath(x, yy, bw, y(0) - yy, 4)}" fill="var(--an-${c.side})" fill-opacity="${op}"/>` +
        (band > 26 ? `<text class="val" x="${x + bw / 2}" y="${yy - 5}" text-anchor="middle">${fmtN(c.value)}</text>` : '');
      const lx = L + band * k + band / 2;
      s += `<text x="${lx}" y="${H - B + 14}" text-anchor="end" transform="rotate(-35 ${lx} ${H - B + 14})">${c.label}</text>` +
        `<rect class="hit" data-i="${k}" x="${L + band * k}" y="${T}" width="${band}" height="${H - T - B}"/>`;
    });
    el.innerHTML = `<svg width="${W}" height="${H + 18}" role="img" aria-label="Запас и опоздание относительно крайнего срока">${s}</svg>`;
    bindHits(el, cols, c => `<div class="t">${c.side === 'early' ? 'Раньше срока' : 'Позже срока'}: ${c.label}</div>` +
      row(`var(--an-${c.side})`, 'Заказов', fmtN(c.value)) + row('', 'Доля', fmtPct(c.value / ms.length)));
    ctx.$('margin-t').innerHTML = table(['Вид продукции', 'Раньше срока', 'Запас, медиана', 'Позже срока', 'Опоздание, медиана', 'Опоздание, максимум'],
      PRODUCTS.map(p => {
        const m = list.filter(t => t.pkey === p.key).map(marginOf).filter(v => v != null);
        const e = m.filter(v => v >= 0), l = m.filter(v => v < 0).map(v => -v);
        return m.length ? [p.label, e.length, fmtH(median(e)), l.length, fmtH(median(l)), fmtH(l.length ? Math.max(...l) : null)] : null;
      }).filter(Boolean));
  }

  // === Люди =================================================================
  // каждый, кто есть в «Выполнении задачи», — один раз на заказ; клик — подсветить в графе связей
  function execs(ctx) {
    const { M, list } = ctx;
    const groups = new Map();
    list.forEach(t => t.workers.forEach(w => { if (!groups.has(w)) groups.set(w, []); groups.get(w).push(t); }));
    const all = [...groups.entries()].map(([k, ts]) => {
      const sl = ts.filter(t => t.onTime != null);
      return { key: k, label: k, value: ts.length, role: M.people[k] || 'Дизайнер',
               med: median(ts.map(t => t.lead).filter(v => v != null)), ok: sl.length ? sl.filter(t => t.onTime).length / sl.length : null };
    }).sort((a, b) => b.value - a.value);
    all.forEach(it => { it.color = ctx.roleColor(it.role); });
    hbars(ctx.$('execs'), all.slice(0, 14), {
      title: 'Исполнители', labelW: 130, active: ctx.st.person,
      tip: it => `<div class="t">${esc(it.label)}</div><div class="g">${esc(it.role)}</div>${row('', 'Заказов', fmtN(it.value))}${row('', 'Медиана выполнения', fmtH(it.med))}${row('', 'В срок', fmtPct(it.ok))}`,
      onClick: it => ctx.update({ person: ctx.st.person === it.key ? '' : it.key }, true),
    });
    ctx.$('execs-t').innerHTML = table(['Исполнитель', 'Профиль', 'Заказов с участием', 'Медиана', 'В срок'],
      all.map(it => [it.label, it.role, it.value, fmtH(it.med), fmtPct(it.ok)]));
  }

  // === География ============================================================
  function geo(ctx) {
    const { list } = ctx;
    const an = list.filter(t => t.an);
    const conflict = an.filter(t => t.an.conflict).length;
    ctx.$('geo-cap').textContent = an.length
      ? `Анализ LLM есть у ${fmtN(an.length)} из ${fmtN(list.length)} заказов за период; связаны с конфликтом — ${fmtPct(conflict / an.length)}.`
      : 'За период нет заказов с анализом LLM.';
    // топ без столбика «Другие»: длинный хвост сжал бы шкалу; остальное — в таблице
    const top = (m, n) => [...m.entries()].map(([key, v]) => ({ key, label: key, value: v })).sort((x, y) => y.value - x.value).slice(0, n);
    const themeMap = countBy(an, t => t.an.themes), regionMap = countBy(an, t => t.areas);
    const more = (m, n, forms) => m.size > n ? `<div class="an-cap">ещё ${m.size - n} ${plural(m.size - n, forms)} — в таблице</div>` : '';
    const elT = ctx.$('themes'), elR = ctx.$('regions');
    if (!an.length) { elT.innerHTML = elR.innerHTML = ctx.$('themes-t').innerHTML = ctx.$('regions-t').innerHTML = ''; return; }
    hbars(elT, top(themeMap, 8), { title: 'Темы', labelW: 150, tip: it => `<div class="t">Тема: ${esc(it.label)}</div>${row('', 'Заказов', fmtN(it.value))}` });
    hbars(elR, top(regionMap, 8), { title: 'Регионы', labelW: 150, tip: it => `<div class="t">Регион: ${esc(it.label)}</div>${row('', 'Заказов', fmtN(it.value))}` });
    elT.insertAdjacentHTML('beforeend', more(themeMap, 8, ['тема', 'темы', 'тем']));
    elR.insertAdjacentHTML('beforeend', more(regionMap, 8, ['регион', 'региона', 'регионов']));
    ctx.$('themes-t').innerHTML = table(['Тема', 'Заказов'], [...themeMap.entries()].sort((a, b) => b[1] - a[1]));
    ctx.$('regions-t').innerHTML = table(['Регион', 'Заказов'], [...regionMap.entries()].sort((a, b) => b[1] - a[1]));
  }

  A.ui = { showTip, hideTip, row, table };
  A.dashboard = { kpis, days, projects, heat, lead, sla, margin, execs, geo };
})(typeof window !== 'undefined' ? window : globalThis);
