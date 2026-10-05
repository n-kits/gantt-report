/*
 * Вкладка «Аналитика»: «От регистрации к крайнему сроку» — диаграмма Санкей (d3 + d3-sankey).
 * Путь заказа: час регистрации → смена регистрации → смена крайнего срока (сегодня / завтра / позже) → час срока.
 * Смены — как в рабочих сутках с 04:00: утро 04–15, вечер 15–02, ночь 02–04. Режимы:
 *   full    — все четыре колонки;
 *   partial — без смены регистрации;
 *   direct  — сразу час регистрации → час срока.
 * Ленты — градиент от цвета узла-источника к цвету узла-получателя.
 */
(function (root) {
  'use strict';

  const A = root.GanttAnalytics;
  const { fmtN, plural, esc } = A.util;
  const DAY_START = 4;
  const SHIFTS = [
    { key: 'morning', label: 'утро', color: 'var(--an-morning)', test: h => h >= 4 && h < 15 },
    { key: 'evening', label: 'вечер', color: 'var(--an-evening)', test: h => h >= 15 || h < 2 },
    { key: 'night', label: 'ночь', color: 'var(--an-night)', test: () => true },
  ];
  const shiftOf = h => SHIFTS.find(s => s.test(h));
  const LATER = { tomorrow: 'завтра', later: 'позже' };
  const hh = h => String(h).padStart(2, '0') + ':00';
  // порядок часов — по рабочим суткам: 04, 05 … 23, 00 … 03
  const hourRank = h => (h - DAY_START + 24) % 24;
  const bizDay = d => { const x = new Date(d.getTime() - DAY_START * 3600000); return Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / 86400000; };
  const UNIT = ['заказ', 'заказа', 'заказов'];

  // заказ → узлы его пути (id узла уникален в своей колонке)
  function path(t) {
    const reg = t.startD, dl = t.deadlineD;
    if (!reg || !dl || dl < reg) return null;
    const rh = reg.getHours(), dh = dl.getHours(), gap = bizDay(dl) - bizDay(reg);
    const rs = shiftOf(rh), ds = shiftOf(dh);
    const day = gap === 0 ? null : gap === 1 ? 'tomorrow' : 'later';
    const tone = day ? 'var(--an-later)' : ds.color;
    return {
      regHour: { id: 'rh' + rh, col: 0, label: hh(rh), group: 'Регистрация', color: shiftOf(rh).color, rank: hourRank(rh) },
      regShift: { id: 'rs' + rs.key, col: 1, label: rs.label, group: 'Смена регистрации', color: rs.color, rank: SHIFTS.indexOf(rs) },
      dlShift: { id: 'ds' + ds.key + (day || ''), col: 2, label: day ? `${LATER[day]}, ${ds.label}` : `сегодня, ${ds.label}`,
                 group: 'Смена крайнего срока', color: tone, rank: (day === 'later' ? 20 : day ? 10 : 0) + SHIFTS.indexOf(ds) },
      dlHour: { id: 'dh' + dh + (day || ''), col: 3, label: hh(dh) + (day ? ` (${LATER[day]})` : ''), group: 'Крайний срок',
                color: tone, rank: (day === 'later' ? 200 : day ? 100 : 0) + hourRank(dh) },
    };
  }

  const STEPS = {
    full: ['regHour', 'regShift', 'dlShift', 'dlHour'],
    partial: ['regHour', 'dlShift', 'dlHour'],
    direct: ['regHour', 'dlHour'],
  };

  function graph(list, mode) {
    const steps = STEPS[mode] || STEPS.full;
    const nodes = new Map(), links = new Map();
    let n = 0;
    list.forEach(t => {
      const p = path(t);
      if (!p) return;
      n++;
      const ns = steps.map(k => p[k]);
      ns.forEach((x, i) => { x.col = i; if (!nodes.has(x.id)) nodes.set(x.id, x); });
      for (let i = 1; i < ns.length; i++) {
        const k = ns[i - 1].id + '\u0002' + ns[i].id;
        links.set(k, (links.get(k) || 0) + 1);
      }
    });
    return {
      n,
      nodes: [...nodes.values()],
      links: [...links.entries()].map(([k, value]) => { const [source, target] = k.split('\u0002'); return { source, target, value }; }),
    };
  }

  let seq = 0;
  function draw(el, list, opts) {
    const d3 = root.d3;
    const ui = A.ui;
    const g = graph(list, opts.mode);
    if (!g.links.length) { el.innerHTML = '<div class="an-empty">Нет заказов с крайним сроком за период</div>'; return { n: 0 }; }
    const W = Math.max(560, el.clientWidth || 900);
    const cols = (STEPS[opts.mode] || STEPS.full).length;
    const H = Math.max(320, Math.min(760, 26 * Math.max(...d3.range(cols).map(c => g.nodes.filter(x => x.col === c).length)) + 40));
    const labelW = 120;
    const sk = d3.sankey().nodeId(d => d.id).nodeWidth(14).nodePadding(10)
      .nodeAlign(d3.sankeyJustify)
      .nodeSort((a, b) => a.rank - b.rank)
      .extent([[labelW, 22], [W - labelW, H - 6]]);
    const { nodes, links } = sk({ nodes: g.nodes.map(d => Object.assign({}, d)), links: g.links.map(d => Object.assign({}, d)) });

    const uid = 'an-sk' + (++seq);
    const svg = d3.create('svg').attr('width', W).attr('height', H).attr('class', 'an-sankey')
      .attr('role', 'img').attr('aria-label', 'От регистрации к крайнему сроку');
    // заголовки колонок
    const colX = [...new Set(nodes.map(d => d.x0))].sort((a, b) => a - b);
    svg.append('g').selectAll('text').data(colX).join('text').attr('class', 'col')
      .attr('x', (x, i) => i === 0 ? x : i === colX.length - 1 ? x + 14 : x + 7).attr('y', 12)
      .attr('text-anchor', (x, i) => i === 0 ? 'start' : i === colX.length - 1 ? 'end' : 'middle')
      .text(x => nodes.find(d => d.x0 === x).group);

    // градиенты лент: от цвета источника к цвету получателя
    const defs = svg.append('defs');
    links.forEach((l, i) => {
      const gr = defs.append('linearGradient').attr('id', `${uid}-${i}`).attr('gradientUnits', 'userSpaceOnUse')
        .attr('x1', l.source.x1).attr('x2', l.target.x0);
      gr.append('stop').attr('offset', '0%').attr('style', `stop-color:${l.source.color}`);
      gr.append('stop').attr('offset', '100%').attr('style', `stop-color:${l.target.color}`);
    });
    const link = svg.append('g').attr('fill', 'none').selectAll('path').data(links).join('path')
      .attr('class', 'band').attr('d', d3.sankeyLinkHorizontal())
      .attr('stroke', (l, i) => `url(#${uid}-${i})`).attr('stroke-width', l => Math.max(1, l.width))
      .on('mousemove', (ev, l) => ui.showTip(ev, `<div class="t">${esc(l.source.label)} → ${esc(l.target.label)}</div>` +
        `<div class="g">${esc(l.source.group)} → ${esc(l.target.group)}</div>` +
        ui.row('', 'Заказов', fmtN(l.value)) + ui.row('', 'Доля', Math.round(100 * l.value / g.n) + '%')))
      .on('mouseleave', ui.hideTip);

    const node = svg.append('g').selectAll('g').data(nodes).join('g');
    node.append('rect').attr('x', d => d.x0).attr('y', d => d.y0).attr('width', d => d.x1 - d.x0)
      .attr('height', d => Math.max(1, d.y1 - d.y0)).attr('rx', 2).attr('style', d => `fill:${d.color}`);
    node.append('text').attr('class', 'lbl')
      .attr('x', d => d.x0 < W / 2 ? d.x0 - 6 : d.x1 + 6).attr('y', d => (d.y0 + d.y1) / 2).attr('dy', '0.35em')
      .attr('text-anchor', d => d.x0 < W / 2 ? 'end' : 'start')
      .text(d => `${d.label} · ${fmtN(d.value)}`);
    // наведение на узел — его ленты ярче, остальные гаснут
    node.on('mousemove', (ev, d) => {
      link.classed('dim', l => l.source !== d && l.target !== d);
      ui.showTip(ev, `<div class="t">${esc(d.label)}</div><div class="g">${esc(d.group)}</div>` +
        ui.row('', 'Заказов', fmtN(d.value)) + ui.row('', 'Доля', Math.round(100 * d.value / g.n) + '%'));
    }).on('mouseleave', () => { link.classed('dim', false); ui.hideTip(); });

    el.replaceChildren(svg.node());
    return { n: g.n };
  }

  function render(ctx) {
    const el = ctx.$('sankey');
    if (!root.d3 || !root.d3.sankey) {
      el.innerHTML = '<div class="an-empty">Загрузка d3-sankey…</div>';
      ctx.loadSankey().then(() => render(ctx), e => { el.innerHTML = `<div class="an-empty">${esc(e.message)}</div>`; });
      return;
    }
    const r = draw(el, ctx.list, { mode: ctx.st.sankeyMode });
    const skipped = ctx.list.length - r.n;
    ctx.$('sankey-sub').textContent = `заказов ${fmtN(r.n)}` + (skipped ? ` · без крайнего срока ${fmtN(skipped)}` : '');
  }

  A.sankey = { render, graph, path, UNIT, plural };
})(typeof window !== 'undefined' ? window : globalThis);
