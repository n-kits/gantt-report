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
      if (onClick) n.addEventListener('click', e => { hideTip(); onClick(it, e); });
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
  // ширина подписи в пикселях — тем же шрифтом, что в SVG (12px, шрифт страницы)
  let measureCtx = null;
  function textW(el, s) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = `12px ${getComputedStyle(el).fontFamily}`;
    return measureCtx.measureText(s).width;
  }
  function fitText(el, s, max) {
    if (textW(el, s) <= max) return s;
    while (s.length > 1 && textW(el, s + '…') > max) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  }

  function hbars(el, items, opts) {
    opts = opts || {};
    if (!items.length) { el.innerHTML = '<div class="an-empty">Нет данных за период</div>'; return; }
    // колонка подписей — под самую длинную подпись (не меньше opts.labelW), но не больше 46% ширины;
    // что не влезло — обрезается по ширине текста, полное название — в подсказке
    const W = widthOf(el), rowH = 26, bh = 16, valW = 44;
    const longest = Math.max(...items.map(it => textW(el, it.label)));
    const labelW = Math.min(Math.max(opts.labelW || 190, longest + 14), W * 0.46);
    const H = items.length * rowH + 4;
    // it.ref — черта «обычно» поверх столбика (режим «Сегодня»): шкала учитывает и её
    const max = Math.max(1, ...items.map(it => Math.max(it.value, it.ref || 0)));
    const x = v => (W - labelW - valW) * v / max;
    let s = `<line class="baseline" x1="${labelW}" x2="${labelW}" y1="0" y2="${H}"/>`;
    items.forEach((it, i) => {
      const yy = i * rowH + 4, w = Math.max(1, x(it.value));
      const dim = (opts.isActive ? !opts.isActive(it) : opts.active && opts.active !== it.key) ? ' class="dim"' : '';
      const label = fitText(el, it.label, labelW - 12);
      s += `<g${dim}><text class="lbl" x="${labelW - 8}" y="${yy + bh / 2 + 4}" text-anchor="end">${esc(label)}</text>` +
        `<path d="${barPath(labelW, yy, w, bh, 4)}" fill="${it.color || 'var(--an-s1)'}"/>` +
        (it.ref != null ? `<line class="ref" x1="${labelW + x(it.ref)}" x2="${labelW + x(it.ref)}" y1="${yy - 3}" y2="${yy + bh + 3}"/>` : '') +
        // цифра — всегда сразу за столбиком; черта «обычно» может пройти по ней — белая обводка держит читаемость
        `<text class="val${it.ref != null ? ' halo' : ''}" x="${labelW + w + 6}" y="${yy + bh / 2 + 4}">${opts.fmt ? opts.fmt(it.value) : fmtN(it.value)}</text></g>` +
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

  // заказы по дням: столбики с разбивкой по видам продукции; в подсказке — когда сверены статусы.
  // Длинный период укрупняется: дни → недели (пн–вс) → месяцы — самый мелкий шаг, при котором столбик
  // не уже MIN_BAND px (st.gran = 'auto'); можно выбрать шаг вручную. Неполный период по краям — бледнее.
  const MIN_BAND = 16;   // столбик с подписью «всего» над ним
  const GRAN_WORD = { day: ['День', 'по дням', 'дни'], week: ['Неделя', 'по неделям', 'недели'], month: ['Месяц', 'по месяцам', 'месяцы'] };
  function days(ctx) {
    const { M, st, list } = ctx;
    const el = ctx.$('days');
    const W = widthOf(el), H = 240, L = 34, R = 8, T = 18, B = 26;   // T — место под подпись «всего» у самого высокого
    // выбор шага — только в режиме «Весь архив»; на остальных периодах шаг всегда автоматический
    const whole = st.from === M.firstDay && st.to === M.lastDay;
    const auto = !whole || !st.gran || st.gran === 'auto';
    const gran = auto ? A.autoGran(st.from, st.to, W - L - R, MIN_BAND) : st.gran;
    const bs = A.buckets(st.from, st.to, gran);
    const shown = PRODUCTS.filter(p => A.passes(st.product, p.key));
    const by = bs.map(b => { const o = Object.assign({}, b, { total: 0 }); PRODUCTS.forEach(p => { o[p.key] = 0; }); return o; });
    const idx = {};
    by.forEach((o, i) => o.days.forEach(d => { idx[d] = i; }));
    list.forEach(t => { const o = by[idx[t.day]]; if (o) { o[t.pkey]++; o.total++; } });
    by.forEach(o => {
      o.sum = shown.reduce((a, p) => a + o[p.key], 0);
      // статусы на: самая ранняя сверка среди дней периода
      const ts = o.days.map(d => M.checked[d]).filter(Boolean).sort();
      o.checked = ts[0] || '';
    });

    ctx.$('days-legend').innerHTML = PRODUCTS.map(p =>
      `<button type="button" data-p="${p.key}" aria-pressed="${A.passes(st.product, p.key)}" title="Клик — только этот вид; Ctrl+клик — добавить или убрать"><span class="sw" style="background:${p.color}"></span>${p.label}</button>`).join('');
    ctx.$('days-legend').querySelectorAll('button').forEach(b => b.addEventListener('click', e =>
      ctx.update({ product: A.toggleItem(st.product, b.dataset.p, e.ctrlKey || e.metaKey) })));
    ctx.$('days-title').textContent = `Заказы ${GRAN_WORD[gran][1]}`;
    const gb = ctx.$('days-gran');
    gb.hidden = !whole;
    gb.querySelectorAll('button').forEach(b => {
      b.setAttribute('aria-pressed', String((b.dataset.g === 'auto') === auto && (auto || b.dataset.g === gran)));
      b.onclick = () => ctx.setGran(b.dataset.g);
    });
    const autoBtn = gb.querySelector('[data-g="auto"]');
    if (autoBtn) autoBtn.textContent = auto ? `Авто · ${GRAN_WORD[gran][2]}` : 'Авто';

    const tk = ticks(Math.max(...by.map(o => o.sum))), max = tk.top;
    const band = (W - L - R) / by.length, bw = Math.min(gran === 'day' ? 24 : 40, Math.max(2, band * 0.7));
    const y = v => T + (H - T - B) * (1 - v / max);
    let s = yAxis(tk, y, L, W, R);
    const lblW = gran === 'month' ? 52 : 46;
    const every = Math.max(1, Math.ceil(by.length / Math.floor((W - L) / lblW)));
    // «всего» над столбиком — у всех или ни у кого: только если самое длинное число влезает в ширину столбика
    const totals = band >= textW(el, fmtN(Math.max(...by.map(o => o.sum)))) + 4;
    by.forEach((o, i) => {
      const x = L + band * i + (band - bw) / 2;
      const op = o.partial ? ' fill-opacity="0.45"' : '';
      let acc = 0;
      const segs = shown.filter(p => o[p.key]);
      segs.forEach((p, j) => {
        const y0 = y(acc), y1 = y(acc + o[p.key]);
        const gap = j < segs.length - 1 ? 2 : 0;           // 2px зазор цвета фона между сегментами
        const h = Math.max(0, y0 - y1);
        s += j === segs.length - 1 ? `<path d="${colPath(x, y1, bw, h, 4)}" fill="${p.color}"${op}/>`
          : `<rect x="${x}" y="${y1 + gap}" width="${bw}" height="${Math.max(0, h - gap)}" fill="${p.color}"${op}/>`;
        acc += o[p.key];
      });
      if (o.sum && totals) s += `<text class="tot${o.partial ? ' part' : ''}" x="${x + bw / 2}" y="${y(o.sum) - 4}" text-anchor="middle">${fmtN(o.sum)}</text>`;
      if (i % every === 0) {
        const wd = new Date(o.key + 'T12:00').getDay();
        const bold = gran === 'day' && (wd === 0 || wd === 6) ? ' style="font-weight:600"' : '';
        s += `<text x="${L + band * i + band / 2}" y="${H - 8}" text-anchor="middle"${bold}>${A.bucketLabel(o)}</text>`;
      }
      s += `<rect class="hit" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${H - T - B}"/>`;
    });
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Заказы ${GRAN_WORD[gran][1]}">${s}</svg>`;
    const title = o => {
      if (o.gran === 'day') return `${dmy(o.key)}, ${new Date(o.key + 'T12:00').toLocaleDateString('ru-RU', { weekday: 'long' })}`;
      const last = addDays(o.key, o.full - 1);
      return (o.gran === 'week' ? `Неделя ${dm(o.key)}–${dm(last)}` : `${A.MONTHS[+o.key.slice(5, 7) - 1]} ${o.key.slice(0, 4)}`);
    };
    const partNote = o => o.partial ? `неполн${o.gran === 'week' ? 'ая' : 'ый'}: ${fmtN(o.days.length)} из ${fmtN(o.full)} дн. (${dm(o.days[0])}–${dm(o.days[o.days.length - 1])})` : '';
    bindHits(el, by, o => `<div class="t">${title(o)}</div>` + (o.partial ? `<div class="g">${partNote(o)}</div>` : '') +
      shown.filter(p => o[p.key]).reverse().map(p => row(p.color, p.label, fmtN(o[p.key]))).join('') +
      row('', 'Всего', fmtN(o.sum)) + (o.gran !== 'day' ? row('', 'В среднем за день', fmt1(o.sum / o.days.length)) : '') +
      (o.checked ? `<div class="g">статусы на ${dmhm(o.checked)}</div>` : ''));
    const head = [GRAN_WORD[gran][0], ...shown.map(p => p.label), 'Всего'].concat(gran !== 'day' ? ['В день', 'Дней'] : [], ['Статусы на']);
    ctx.$('days-t').innerHTML = table(head, by.map(o => [gran === 'day' ? dmy(o.key) : title(o), ...shown.map(p => o[p.key]), o.sum]
      .concat(gran !== 'day' ? [fmt1(o.sum / o.days.length), o.partial ? `${o.days.length} из ${o.full}` : o.full] : [], [dmhm(o.checked)])));
  }

  function projects(ctx) {
    const { M, st } = ctx;
    // проекты — без фильтра по проекту, чтобы видеть выбранный среди остальных
    const list = M.tasks.filter(t => A.inRange(t, st.from, st.to) && A.passes(st.product, t.pkey));
    const items = topN(countBy(list, t => t.project), 9, 'Другие').map(it => Object.assign(it, { color: it.other ? 'var(--an-other)' : 'var(--an-s1)' }));
    hbars(ctx.$('projects'), items, {
      title: 'Проекты', labelW: 170,
      isActive: it => !A.isOn(st.project) || (!it.other && A.passes(st.project, it.key)),
      onClick: (it, e) => { if (!it.other) ctx.update({ project: A.toggleItem(st.project, it.key, e && (e.ctrlKey || e.metaKey)) }); },
    });
    ctx.$('projects-t').innerHTML = table(['Проект', 'Заказов'], [...countBy(list, t => t.project).entries()].sort((a, b) => b[1] - a[1]));
  }

  // тепловая карта: день недели × час регистрации
  // палитра Reds (matplotlib / seaborn cmap="Reds", ColorBrewer): t 0…1 → цвет, линейно между опорными
  const REDS = ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d']
    .map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));
  function reds(t) {
    const x = Math.max(0, Math.min(1, t)) * (REDS.length - 1), i = Math.min(REDS.length - 2, Math.floor(x)), f = x - i;
    return `rgb(${REDS[i].map((c, k) => Math.round(c + (REDS[i + 1][k] - c) * f)).join(',')})`;
  }

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
      // ноль — белый, остальное — по палитре; тонкая обводка, чтобы белые и светлые клетки не сливались с фоном
      s += `<rect class="hc" x="${L + h * cw + 1}" y="${T + d * ch + 1}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="${v ? reds(v / max) : '#fff'}"/>` +
        `<rect class="hit" data-i="${i}" x="${L + h * cw}" y="${T + d * ch}" width="${cw}" height="${ch}"/>`;
    }));
    WD.forEach((w, d) => { s += `<text x="${L - 6}" y="${T + d * ch + ch / 2 + 4}" text-anchor="end">${w}</text>`; });
    // каждый час; на узком экране (телефон) подписи не влезают — через 3 часа
    for (let h = 0; h < 24; h += cw >= 20 ? 1 : 3) s +=`<text x="${L + h * cw + cw / 2}" y="${H - 6}" text-anchor="middle">${String(h).padStart(2, '0')}</text>`;
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
    if (!leads.length) { el.innerHTML = '<div class="an-empty">Нет выполненных заказов</div>'; ctx.$('lead-t').innerHTML = ''; return; }
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
      `<div class="an-cap">Медиана — ${fmtH(median(leads.map(t => t.lead)))}; выполненных — ${fmtN(leads.length)}.</div>`;
    bindHits(el, bins, b => `<div class="t">${b.label}</div>${row('', 'Заказов', fmtN(b.value))}${row('', 'Из них в срок', b.sla ? fmtPct(b.ok / b.sla) : '—')}`);
    ctx.$('lead-t').innerHTML = table(['Время', 'Заказов', 'В срок'], bins.map(b => [b.label, b.value, b.sla ? fmtPct(b.ok / b.sla) : '—']));
  }

  function sla(ctx) {
    const el = ctx.$('sla');
    const rows = PRODUCTS.map(p => {
      const s = ctx.list.filter(t => t.pkey === p.key && t.onTime != null);
      return { p, ok: s.filter(t => t.onTime).length, bad: s.filter(t => !t.onTime).length };
    }).filter(r => r.ok + r.bad);
    if (!rows.length) { el.innerHTML = '<div class="an-empty">Нет выполненных заказов с крайним сроком</div>'; ctx.$('sla-t').innerHTML = ''; return; }
    const W = widthOf(el), rowH = 34, bh = 18, labelW = Math.min(170, W * 0.4), H = rows.length * rowH;
    const bw = W - labelW - 8;
    let s = '';
    rows.forEach((r, i) => {
      const n = r.ok + r.bad, yy = i * rowH + 6, wOk = bw * r.ok / n, gap = r.ok && r.bad ? 2 : 0;
      s += `<text class="lbl" x="${labelW - 8}" y="${yy + bh / 2 + 4}" text-anchor="end">${esc(r.p.label)}</text>`;
      if (r.ok) s += r.bad ? `<rect x="${labelW}" y="${yy}" width="${wOk}" height="${bh}" fill="var(--an-good)"/>` : `<path d="${barPath(labelW, yy, wOk, bh, 4)}" fill="var(--an-good)"/>`;
      if (r.bad) s += `<path d="${barPath(labelW + wOk + gap, yy, bw - wOk - gap, bh, 4)}" fill="var(--an-critical)"/>`;
      if (wOk > 64) s += `<text x="${labelW + 8}" y="${yy + bh / 2 + 4}" style="fill:#fff;font-weight:600">✓ ${Math.round(100 * r.ok / n)}%</text>`;
      // доля с нарушением — у правого края красного отрезка
      if (bw - wOk - gap > 64) s += `<text x="${labelW + bw - 8}" y="${yy + bh / 2 + 4}" text-anchor="end" style="fill:#fff;font-weight:600">! ${100 - Math.round(100 * r.ok / n)}%</text>`;   // в сумме с зелёной — ровно 100
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
    if (!ms.length) { el.innerHTML = '<div class="an-empty">Нет выполненных заказов с крайним сроком</div>'; ctx.$('margin-t').innerHTML = ''; return; }
    if (ctx.st.marginView === 'ticks') { strips(ctx, el, list); marginTable(ctx, list); return; }
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
    marginTable(ctx, list);
  }

  function marginTable(ctx, list) {
    ctx.$('margin-t').innerHTML = table(['Вид продукции', 'Раньше срока', 'Запас, медиана', 'Позже срока', 'Опоздание, медиана', 'Опоздание, максимум'],
      PRODUCTS.map(p => {
        const m = list.filter(t => t.pkey === p.key).map(marginOf).filter(v => v != null);
        const e = m.filter(v => v >= 0), l = m.filter(v => v < 0).map(v => -v);
        return m.length ? [p.label, e.length, fmtH(median(e)), l.length, fmtH(median(l)), fmtH(l.length ? Math.max(...l) : null)] : null;
      }).filter(Boolean));
  }

  // «Штрихи» (Observable Plot): каждый заказ — черта на оси «часы относительно срока», красная вертикаль — крайний срок,
  // жёлтая черта — медиана строки. Строки — проекты, исполнители (только одиночные заказы) или дни.
  // Шкала обрезана: ±STRIP_H часов; заказы дальше прижаты к краю, их число — подписью у края.
  const STRIP_H = 12;
  const ROWS = {
    project: { label: 'Проект', of: t => [t.project], sort: true },
    worker: { label: 'Исполнитель', of: t => t.workers.length === 1 ? t.workers : [], sort: true },
    day: { label: 'День', of: t => [dm(t.day)], sort: false },
  };
  function strips(ctx, el, list) {
    const Plot = root.Plot;
    if (!Plot) { el.innerHTML = '<div class="an-empty">Загрузка Observable Plot…</div>'; ctx.loadPlot().then(() => margin(ctx), e => { el.innerHTML = `<div class="an-empty">${esc(e.message)}</div>`; }); return; }
    const R = ROWS[ctx.st.marginRows] || ROWS.project;
    const data = [];
    list.forEach(t => {
      const m = marginOf(t);
      if (m == null) return;
      const h = -m;                                      // > 0 — позже срока (справа)
      R.of(t).forEach(row => data.push({ row, h, x: Math.max(-STRIP_H, Math.min(STRIP_H, h)), id: t.id, day: t.day }));
    });
    if (!data.length) { el.innerHTML = '<div class="an-empty">Нет заказов для этих строк</div>'; return; }
    const byRow = d3group(data, d => d.row);
    const rows = [...byRow.entries()].map(([row, ds]) => ({ row, n: ds.length, med: median(ds.map(d => d.h)),
      lo: ds.filter(d => d.h < -STRIP_H).length, hi: ds.filter(d => d.h > STRIP_H).length }));
    if (R.sort) rows.sort((a, b) => a.med - b.med); else rows.sort((a, b) => byRow.get(a.row)[0].day < byRow.get(b.row)[0].day ? -1 : 1);
    const order = rows.map(r => r.row);
    const fmtSigned = h => h === 0 ? 'в срок' : (h < 0 ? 'раньше на ' : 'позже на ') + fmtH(Math.abs(h));
    const W = widthOf(el);
    // подписи по оси: каждый час, а если места хватает (≥ 56px на час) — и каждые полчаса; деления — всегда через полчаса
    const ml = Math.min(170, W * 0.3), perHour = (W - ml - 8) / (2 * STRIP_H + 2.8);
    const hours = d3range(-STRIP_H, STRIP_H, 1), halves = d3range(-STRIP_H, STRIP_H, 0.5);
    const labelStep = perHour >= 56 ? 0.5 : perHour >= 22 ? 1 : 2;
    const fmtTick = h => h === 0 ? '0' : (h > 0 ? '+' : '−') + String(Math.abs(h)).replace('.', ',');
    // строки — в своей области; больше MAX_ROWS — она прокручивается, ось часов закреплена под ней
    // (отдельным графиком с теми же полями и шкалой); в «Днях» область открывается на последних днях
    const ROW_H = 22, MAX_ROWS = 30, scroll = order.length > MAX_ROWS;
    const wrap = document.createElement('div');
    wrap.className = 'an-strips' + (scroll ? ' scroll' : '');
    if (scroll) wrap.style.maxHeight = (MAX_ROWS * ROW_H + 6) + 'px';
    el.replaceChildren(wrap);
    const bodyW = wrap.clientWidth || W;              // без полосы прокрутки, если она есть
    const style = { fontFamily: 'inherit', fontSize: '12px', color: 'var(--an-ink-2)', background: 'transparent', overflow: 'visible' };
    const x = { domain: [-STRIP_H - 1.4, STRIP_H + 1.4] };
    const body = Plot.plot({
      width: bodyW, height: 6 + order.length * ROW_H, marginLeft: ml, marginRight: 8, marginTop: 6, marginBottom: 0, style,
      x: Object.assign({ axis: null }, x),
      y: { domain: order, label: null, tickFormat: r => String(r).length > 26 ? String(r).slice(0, 25) + '…' : r },
      marks: [
        Plot.gridX(hours, { stroke: 'var(--an-grid)', strokeOpacity: 1 }),
        Plot.tickX(data, { x: 'x', y: 'row', stroke: 'var(--an-ink)', strokeOpacity: 0.35,
          title: d => `${d.row}
${fmtSigned(d.h)}` }),
        Plot.ruleX([0], { stroke: 'var(--an-critical)', strokeWidth: 2 }),
        Plot.tickX(rows, { x: r => Math.max(-STRIP_H, Math.min(STRIP_H, r.med)), y: 'row', stroke: 'var(--an-median)', strokeWidth: 4,
          title: r => `${r.row}
медиана: ${fmtSigned(r.med)}
заказов: ${r.n}` }),
        Plot.text(rows.filter(r => r.hi), { x: STRIP_H + 0.4, y: 'row', text: r => '+' + r.hi, textAnchor: 'start', fill: 'var(--an-late)', fontWeight: 700 }),
        Plot.text(rows.filter(r => r.lo), { x: -STRIP_H - 0.4, y: 'row', text: r => '+' + r.lo, textAnchor: 'end', fill: 'var(--an-early)', fontWeight: 700 }),
      ],
    });
    const axis = Plot.plot({
      width: W, height: 40, marginLeft: ml, marginRight: 8 + (W - bodyW), marginTop: 0, marginBottom: 36, style, x,
      marks: [
        Plot.axisX(halves, { tickFormat: () => '', tickSize: 3, label: null }),
        Plot.axisX(d3range(-STRIP_H, STRIP_H, labelStep), { tickFormat: fmtTick, tickSize: 6,
          label: '← раньше срока · часы · позже срока →', labelAnchor: 'center' }),
      ],
    });
    wrap.appendChild(body);
    el.appendChild(axis);
    if (scroll && R === ROWS.day) wrap.scrollTop = wrap.scrollHeight;
  }
  const d3range = (a, b, step) => { const r = []; for (let x = a; x <= b + 1e-9; x += step) r.push(x); return r; };
  const d3group = (a, f) => { const m = new Map(); a.forEach(x => { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; };

  // === Люди =================================================================
  // каждый, кто есть в «Выполнении задачи», — один раз на заказ; клик — подсветить в графе связей.
  // Медиана и «в срок» — отдельно по одиночным и совместным заказам: совместный заказ — общий результат
  // всех участников, и задержка одного не должна выглядеть как личная статистика другого.
  function execs(ctx) {
    const { M, list } = ctx;
    const groups = new Map();
    list.forEach(t => t.workers.forEach(w => { if (!groups.has(w)) groups.set(w, []); groups.get(w).push(t); }));
    const stat = ts => {
      const sl = ts.filter(t => t.onTime != null);
      return { n: ts.length, med: median(ts.map(t => t.lead).filter(v => v != null)),
               ok: sl.length ? sl.filter(t => t.onTime).length / sl.length : null };
    };
    const all = [...groups.entries()].map(([k, ts]) => ({
      key: k, label: k, value: ts.length, role: M.people[k] || 'Дизайнер',
      solo: stat(ts.filter(t => t.workers.length === 1)), team: stat(ts.filter(t => t.workers.length > 1)),
    })).sort((a, b) => b.value - a.value);
    all.forEach(it => { it.color = ctx.roleColor(it.role); });
    const part = (title, x) => `<div class="g">${title} — ${fmtN(x.n)}</div>` +
      (x.n ? row('', 'Медиана выполнения', fmtH(x.med)) + row('', 'В срок', fmtPct(x.ok)) : '');
    hbars(ctx.$('execs'), all.slice(0, 14), {
      title: 'Исполнители', labelW: 130, active: ctx.st.person,
      tip: it => `<div class="t">${esc(it.label)}</div><div class="g">${esc(it.role)} · заказов ${fmtN(it.value)}</div>` +
        part('Один', it.solo) + part('Совместно', it.team),
      onClick: it => ctx.update({ person: ctx.st.person === it.key ? '' : it.key }, true),
    });
    // компактная таблица под узкую карточку: профиль — цветной точкой, «Один» и «Совместно» — группами колонок
    const cells = x => x.n ? `<td class="n">${fmtN(x.n)}</td><td class="n">${fmtH(x.med)}</td><td class="n">${fmtPct(x.ok)}</td>`
      : '<td class="n">0</td><td></td><td></td>';
    ctx.$('execs-t').innerHTML = `<table class="compact"><thead>` +
      `<tr><th rowspan="2">Исполнитель</th><th rowspan="2" class="n">Всего</th><th colspan="3" class="grp">Один</th><th colspan="3" class="grp">Совместно</th></tr>` +
      `<tr><th class="n">зак.</th><th class="n" title="медиана выполнения">мед.</th><th class="n">в срок</th><th class="n">зак.</th><th class="n" title="медиана выполнения">мед.</th><th class="n">в срок</th></tr></thead><tbody>` +
      all.map(it => `<tr><td title="${esc(it.label)} · ${esc(it.role)}"><span class="sw round" style="background:${it.color}"></span> <span class="nm">${esc(it.label)}</span></td>` +
        `<td class="n">${fmtN(it.value)}</td>${cells(it.solo)}${cells(it.team)}</tr>`).join('') + `</tbody></table>`;
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

  // === Сегодня ==============================================================
  // ctx.T — A.today(): день против того же дня недели прошлых недель, к тому же часу
  const fmtRef = x => x == null ? '—' : fmt1(x);
  const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const hourLabel = k => String((A.DAY_START + Math.floor(k)) % 24).padStart(2, '0') + ':00';

  // «▲ 30% к медиане 12» / «как обычно»; обычно = медиана, разброс — средняя половина дней
  // разброс — целыми (заказы штучные); на малых числах — разница в штуках, проценты от 1–4 только шумят
  function vsTypical(v, x, word) {
    if (!x.n) return 'истории для сравнения пока нет';
    const lo = Math.round(x.lo), hi = Math.round(x.hi);
    const range = lo !== hi ? ` (обычно ${fmtN(lo)}–${fmtN(hi)})` : '';
    const diff = v - x.med;
    let head;
    if (Math.abs(diff) < 0.5 || (x.med >= 5 && Math.abs(diff / x.med) < 0.05)) head = '<b>как обычно</b>';
    else if (x.med < 5) head = `<b>${diff > 0 ? '▲' : '▼'} на ${fmtRef(Math.abs(diff))}</b> ${diff > 0 ? 'больше' : 'меньше'} медианы ${fmtRef(x.med)}`;
    else head = `<b>${diff > 0 ? '▲' : '▼'} ${Math.abs(Math.round(diff / x.med * 100))}%</b> к медиане ${fmtRef(x.med)}`;
    return `${head} ${word}${range}`;
  }

  function todayKpis(ctx) {
    const T = ctx.T, word = `по ${T.refWord}`;
    const left = T.fullDay.med != null && T.arrived.med != null ? Math.max(0, Math.round(T.fullDay.med - T.arrived.med)) : null;
    ctx.$('t-kpis').innerHTML = [
      `<div class="kpi hero"><div class="label">Заказов к ${hhmm(T.now)}</div><div class="value">${fmtN(T.arrived.today)}</div>` +
        `<div class="delta">${vsTypical(T.arrived.today, T.arrived, word)}</div></div>`,
      `<div class="kpi"><div class="label">Обычно за весь день</div><div class="value">${fmtRef(T.fullDay.med)}</div>` +
        `<div class="delta">${left != null ? `после этого часа обычно приходит ещё ~${fmtN(left)}` : 'нет истории'}</div></div>`,
      `<div class="kpi"><div class="label">В работе сейчас</div><div class="value">${fmtN(T.open.today)}</div>` +
        `<div class="delta">${vsTypical(T.open.today, T.open, word)}</div></div>`,
      `<div class="kpi"><div class="label">Просрочено сейчас</div><div class="value">${fmtN(T.late.today)}</div>` +
        `<div class="delta">${vsTypical(T.late.today, T.late, word)}</div></div>`,
    ].join('');
  }

  // плавная линия через точки без ложных горбов — монотонная кубическая (Fritsch–Carlson, как d3.curveMonotoneX):
  // проходит точно через часовые значения, между ними не выходит за соседние; нарастающий итог не «проседает»
  function smooth(ps, move) {
    const n = ps.length;
    if (n < 3) return (move ? 'M' : 'L') + ps.map(p => p.join(',')).join('L');
    const dx = [], d = [], m = [];
    for (let i = 0; i < n - 1; i++) { dx.push(ps[i + 1][0] - ps[i][0]); d.push(dx[i] ? (ps[i + 1][1] - ps[i][1]) / dx[i] : 0); }
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (!d[i]) { m[i] = m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], q = a * a + b * b;
      if (q > 9) { const t = 3 / Math.sqrt(q); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    let s = `${move ? 'M' : 'L'}${ps[0][0]},${ps[0][1]}`;
    for (let i = 0; i < n - 1; i++) {
      const h3 = dx[i] / 3;
      s += `C${ps[i][0] + h3},${ps[i][1] + m[i] * h3} ${ps[i + 1][0] - h3},${ps[i + 1][1] - m[i + 1] * h3} ${ps[i + 1][0]},${ps[i + 1][1]}`;
    }
    return s;
  }

  // часы суток с 04:00: полоса — средняя половина обычных дней, пунктир — медиана, линия — сегодня до «сейчас»
  function dayCurve(el, pts, opts) {
    const W = widthOf(el), H = 220, L = 34, R = 10, T = 10, B = 26;
    const tk = ticks(Math.max(1, ...pts.map(p => Math.max(p.today || 0, p.hi || 0)))), max = tk.top;
    const x = k => L + (W - L - R) * k / 24, y = v => T + (H - T - B) * (1 - v / max);
    let s = yAxis(tk, y, L, W, R);
    for (let k = 0; k <= 24; k += 4) s += `<text x="${x(k)}" y="${H - 8}" text-anchor="middle">${hourLabel(k).slice(0, 2)}</text>`;
    const ref = pts.filter(p => p.med != null);
    if (ref.length) {
      s += `<path class="t-band" d="${smooth(ref.map(p => [x(p.k), y(p.hi)]), true)}${smooth(ref.slice().reverse().map(p => [x(p.k), y(p.lo)]), false)}Z"/>`;
      s += `<path class="median" d="${smooth(ref.map(p => [x(p.k), y(p.med)]), true)}"/>`;
    }
    const tod = pts.filter(p => p.today != null);
    if (tod.length) {
      s += `<path class="today" d="${smooth(tod.map(p => [x(p.k), y(p.today)]), true)}"/>`;
      const last = tod[tod.length - 1];
      s += `<line class="now" x1="${x(last.k)}" x2="${x(last.k)}" y1="${T}" y2="${H - B}"/>` +
        `<circle class="today-dot" cx="${x(last.k)}" cy="${y(last.today)}" r="3.5"/>`;
    }
    // зоны подсказки — по целым часам
    const hours = pts.filter(p => Number.isInteger(p.k)), cw = (W - L - R) / 24;
    hours.forEach((p, i) => { s += `<rect class="hit" data-i="${i}" x="${x(p.k) - cw / 2}" y="${T}" width="${cw}" height="${H - T - B}"/>`; });
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(opts.title)}">${s}</svg>`;
    bindHits(el, hours, p => `<div class="t">${opts.at(p.k)}</div>` +
      (p.today != null ? row('var(--an-today)', 'Сегодня', fmtN(p.today)) : '') +
      (p.med != null ? row('', `Медиана по ${opts.refWord}`, fmtRef(p.med)) + row('', 'Обычно', `${fmtRef(p.lo)}–${fmtRef(p.hi)}`) : ''));
  }

  // темы и места дня: столбик — сегодня, черта — в среднем в день за 4 недели, «новое» — зелёным
  function vsPastBars(el, list, opts, T) {
    const items = list.slice(0, 15).map(p => Object.assign({}, p, { label: p.label + (p.isNew ? ' · новое' : ''), color: p.isNew ? 'var(--an-new)' : 'var(--an-s1)' }));
    if (!items.length) { el.innerHTML = `<div class="an-empty">${opts.empty}</div>`; return; }
    hbars(el, items, { title: opts.title, labelW: 190,
      tip: it => `<div class="t">${esc(it.label)}</div>${it.area ? `<div class="g">${esc(it.area)}</div>` : ''}` +
        row('', 'Заказов сегодня', fmtN(it.value)) +
        row('', `В среднем в день за ${T.placeDays} дн.`, it.isNew ? 'не было' : fmt1(it.ref)) });
  }

  function todayView(ctx) {
    const T = ctx.T;
    ctx.$('t-cap').textContent = `${dmy(T.day)}, к ${hhmm(T.now)} · сравнение с тем же часом по ${T.refWord}: ` +
      (T.refs.length ? `${fmtN(T.refs.length)} ${plural(T.refs.length, ['неделя', 'недели', 'недель'])} (${T.refs.map(dm).join(', ')})` : 'истории пока нет');
    todayKpis(ctx);
    document.querySelectorAll('.an-t-legend').forEach(el => {
      el.innerHTML = `<span><span class="ln"></span>сегодня</span><span><span class="ln med"></span>медиана по ${T.refWord}</span>` +
        `<span><span class="bd"></span>обычный разброс (средняя половина дней)</span>`;
    });
    const curveTable = pts => table(['Час', 'Сегодня', 'Медиана', 'Обычно от', 'до'],
      pts.filter(p => Number.isInteger(p.k)).map(p => [hourLabel(p.k), p.today == null ? '' : p.today, fmtRef(p.med), fmtRef(p.lo), fmtRef(p.hi)]));
    dayCurve(ctx.$('t-arrived'), T.curves.arrived, { title: 'Поступление заказов', refWord: T.refWord, at: k => `пришло к ${hourLabel(k)}` });
    ctx.$('t-arrived-t').innerHTML = curveTable(T.curves.arrived);
    dayCurve(ctx.$('t-open'), T.curves.open, { title: 'Одновременно в работе', refWord: T.refWord, at: k => `в работе в ${hourLabel(k)}` });
    ctx.$('t-open-t').innerHTML = curveTable(T.curves.open);

    const tipRef = it => `<div class="t">${esc(it.label)}</div>${row('', 'Сегодня', fmtN(it.value))}${row('', `Медиана по ${T.refWord}`, fmtRef(it.ref))}`;
    const prod = T.products.map(p => { const P = PRODUCTS.find(x => x.key === p.key); return Object.assign({}, p, { label: P.label, color: P.color }); });
    if (prod.length) hbars(ctx.$('t-products'), prod, { title: 'Виды продукции', labelW: 150, tip: tipRef });
    else ctx.$('t-products').innerHTML = '<div class="an-empty">Заказов к этому часу нет ни сегодня, ни обычно</div>';
    const proj = T.projects.slice(0, 10).map(p => Object.assign({}, p, { label: p.key, color: 'var(--an-s1)' }));
    if (proj.length) hbars(ctx.$('t-projects'), proj, { title: 'Проекты', labelW: 150, tip: tipRef });
    else ctx.$('t-projects').innerHTML = '<div class="an-empty">Заказов к этому часу нет ни сегодня, ни обычно</div>';
    const refTable = list => table(['', 'Сегодня', 'Медиана'], list.map(p => [p.label || p.key, p.value, fmtRef(p.ref)]));
    ctx.$('t-products-t').innerHTML = refTable(prod);
    ctx.$('t-projects-t').innerHTML = refTable(T.projects);

    const n = T.arrived.today;
    const anCap = n ? `Анализ LLM есть у ${fmtN(T.analyzed)} из ${fmtN(n)} заказов дня.` : '';
    ctx.$('t-places-cap').textContent = anCap;
    ctx.$('t-themes-cap').textContent = anCap;
    vsPastBars(ctx.$('t-places'), T.places, { title: 'Места сегодня', empty: n ? 'Мест в заказах дня пока нет' : 'Заказов сегодня пока нет' }, T);
    ctx.$('t-places-t').innerHTML = table(['Место', 'Регион', 'Сегодня', 'В среднем в день'],
      T.places.map(p => [p.label, p.area || '', p.value, p.isNew ? 'новое' : fmt1(p.ref)]));
    vsPastBars(ctx.$('t-themes'), T.themes, { title: 'Темы сегодня', empty: n ? 'Тем в заказах дня пока нет' : 'Заказов сегодня пока нет' }, T);
    ctx.$('t-themes-t').innerHTML = table(['Тема', 'Сегодня', 'В среднем в день'],
      T.themes.map(p => [p.label, p.value, p.isNew ? 'новое' : fmt1(p.ref)]));

    // исполнители: нагрузка смены против обычного и кто сегодня сколько взял (без сравнения людей с их прошлым)
    const C = T.crew, word = `по ${T.refWord}`;
    ctx.$('t-crew').innerHTML =
      `<div class="kpi"><div class="label">Людей в работе</div><div class="value">${fmtN(C.people.today)}</div><div class="delta">${vsTypical(C.people.today, C.people, word)}</div></div>` +
      `<div class="kpi" title="Совместный заказ засчитывается каждому участнику целиком — как в списке ниже"><div class="label">Заказов на человека</div><div class="value">${C.perPerson.today == null ? '—' : fmt1(C.perPerson.today)}</div>` +
        `<div class="delta">${C.perPerson.today == null ? '' : vsTypical(C.perPerson.today, C.perPerson, word)}</div></div>` +
      `<div class="kpi" title="Заказы дня с 2 и больше исполнителями (передачи, совместная работа) среди взятых"><div class="label">Совместных</div><div class="value">${fmtPct(C.joint.today)}</div>` +
        `<div class="delta">${C.joint.today == null || !C.joint.n ? '' : `обычно ${fmtPct(C.joint.med)} ${word}` + (Math.round(C.joint.lo * 100) !== Math.round(C.joint.hi * 100) ? ` (${fmtPct(C.joint.lo)}–${fmtPct(C.joint.hi)})` : '')}</div></div>` +
      `<div class="kpi"><div class="label">Ещё не взяты</div><div class="value">${fmtN(C.notTaken)}</div><div class="delta">заказы дня без исполнителя</div></div>`;
    const ws = T.workers.map(w => Object.assign({}, w, { color: ctx.roleColor(w.role) }));
    if (!ws.length) ctx.$('t-workers').innerHTML = '<div class="an-empty">Сегодня заказы ещё никто не брал</div>';
    else hbars(ctx.$('t-workers'), ws.slice(0, 15), { title: 'Исполнители сегодня', labelW: 150,
      tip: it => `<div class="t">${esc(it.label)}</div><div class="g">${esc(it.role)}</div>` +
        row('', 'Взял заказов сегодня', fmtN(it.value)) + row('', 'В работе сейчас (не сдано)', fmtN(it.busy)) });
    ctx.$('t-workers-legend').innerHTML = [...new Set(ws.map(w => w.role))].sort()
      .map(r => `<span><span class="sw round" style="background:${ctx.roleColor(r)}"></span>${esc(r)}</span>`).join('');
    ctx.$('t-workers-t').innerHTML = table(['Исполнитель', 'Профиль', 'Взял сегодня', 'В работе сейчас'],
      T.workers.map(w => [w.label, w.role, w.value, w.busy]));
  }

  A.ui = { showTip, hideTip, row, table };
  A.dashboard = { kpis, days, projects, heat, lead, sla, margin, execs, geo, todayView };
})(typeof window !== 'undefined' ? window : globalThis);
