/*
 * Вкладка «Аналитика»: граф связей (hierarchical edge bundling, d3 v7) — исполнители и топонимы.
 * По мотивам https://observablehq.com/@d3/hierarchical-edge-bundling
 * draw(el, g, opts): g — граф из data.js (graphPeople / graphPlaces), opts — beta, minw, pin (узел, подсвеченный
 * щелчком снаружи), color(группа), legend и table — элементы для легенды и таблицы связей.
 */
(function (root) {
  'use strict';

  const A = root.GanttAnalytics;
  const { fmtN, plural, esc } = A.util;
  const UNIT = ['общий заказ', 'общих заказа', 'общих заказов'];

  function draw(el, g, opts) {
    const d3 = root.d3;
    const ui = A.ui;
    // linkedOnly — без узлов, у которых нет ни одного общего заказа с другими (люди, работавшие только в одиночку)
    if (opts.linkedOnly) {
      const linked = new Set(g.edges.flatMap(e => [e.a, e.b]));
      g = Object.assign({}, g, { leaves: g.leaves.filter(l => linked.has(l.id)) });
    }
    const edges = g.edges.filter(e => e.w >= opts.minw);
    const maxW = Math.max(1, ...g.edges.map(e => e.w));
    const n = g.leaves.length;
    if (!n) {
      el.innerHTML = '<div class="an-empty">Нет данных за период</div>';
      opts.legend.innerHTML = ''; opts.table.innerHTML = '';
      return { shown: 0, total: 0, maxW, n };
    }

    // группы по размеру; легенда — названные группы, остальные серые
    const groupN = d3.rollup(g.leaves, v => d3.sum(v, d => d.n), d => d.group);
    const groups = [...groupN.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const color = opts.color(groups);
    opts.legend.innerHTML = color.legend;

    // иерархия: корень → группа → (регион) → лист
    const tree = { name: '', children: groups.map(k => {
      const ls = g.leaves.filter(l => l.group === k);
      if (!g.nested) return { name: k, children: ls.map(l => ({ name: l.label, leaf: l })) };
      const subs = d3.group(ls, l => l.sub);
      return { name: k, children: [...subs.entries()].sort((a, b) => d3.sum(b[1], x => x.n) - d3.sum(a[1], x => x.n))
        .map(([sk, sl]) => ({ name: sk, children: sl.map(l => ({ name: l.label, leaf: l })) })) };
    }) };

    const rootNode = d3.hierarchy(tree);
    // сколько «шагов» по окружности: соседи в одной группе — 1, на стыке групп — 2 (как separation ниже), плюс замыкание круга
    const lv = rootNode.leaves();
    let units = 2;
    for (let i = 1; i < lv.length; i++) units += lv[i].parent === lv[i - 1].parent ? 1 : 2;
    const longest = d3.max(g.leaves, l => Math.min(28, l.label.length)) || 10;
    const labelOf = f => 22 + longest * f * 0.58;
    // размер, при котором подписи не наезжают друг на друга: шаг по дуге — 0,95 кегля
    // (у строчных букв высота меньше кегля, так что зазор остаётся и при шаге чуть меньше кегля)
    const need = f => 2 * (units * f * 0.95 / (2 * Math.PI) + labelOf(f) + 10);
    const avail = el.clientWidth || 800;
    let font = n <= 60 ? 13 : 11;                      // мало узлов — подписи крупнее
    let size;
    if (opts.fitScreen) {
      // базовый размер — середина между «целиком в высоту окна» и «во всю ширину карточки»;
      // подписям тесно — фигура растёт до ширины карточки, затем шрифт 10px, и только потом шире карточки
      // (тогда график прокручивается вбок внутри карточки)
      const bar = document.querySelector('.an-bar');
      const top = bar && getComputedStyle(bar).position === 'sticky' ? bar.offsetHeight : 0;
      const fit = Math.min(avail, innerHeight - top - 16);
      if (need(font) > avail) font = 10;
      size = Math.max(560, Math.round((fit + avail) / 2), need(font));
    } else {
      // мало узлов — фигура компактнее, чтобы не растягивать раздел на несколько экранов
      size = Math.max(560, Math.min(n <= 40 ? 760 : 1100, avail), need(font));
    }
    const labelR = labelOf(font);
    const radius = size / 2 - labelR;
    d3.cluster().size([2 * Math.PI, radius]).separation((a, b) => a.parent === b.parent ? 1 : 2)(rootNode);
    const byId = new Map(rootNode.leaves().map(d => [d.data.leaf.id, d]));
    const line = d3.lineRadial().curve(d3.curveBundle.beta(opts.beta)).radius(d => d.y).angle(d => d.x);
    const width = d3.scaleSqrt().domain([1, maxW]).range([0.8, 4.5]);
    const op = d3.scaleLinear().domain([1, maxW]).range([0.22, 0.75]);

    // фигура масштабируется по ширине карточки (viewBox), подписи — в единицах фигуры
    const svg = d3.create('svg').attr('viewBox', [-size / 2, -size / 2, size, size]).attr('class', 'an-bundle')
      .style('font-size', font + 'px').style('max-width', size + 'px').style('min-width', size > avail ? size + 'px' : null).attr('role', 'img').attr('aria-label', opts.title || '');
    const arc = d3.arc().innerRadius(radius + 3).outerRadius(radius + 6);
    for (const grp of rootNode.children) {
      const ls = grp.leaves(), a0 = d3.min(ls, d => d.x) - 0.012, a1 = d3.max(ls, d => d.x) + 0.012;
      svg.append('path').attr('d', arc({ startAngle: a0, endAngle: a1 })).attr('fill', color.of(grp.data.name));
    }
    const links = svg.append('g').selectAll('path').data(edges.slice().sort((a, b) => a.w - b.w)).join('path')
      .attr('class', 'link').attr('d', e => line(byId.get(e.a).path(byId.get(e.b))))
      .attr('stroke-width', e => width(e.w)).attr('stroke-opacity', e => op(e.w))
      .on('mousemove', (ev, e) => ui.showTip(ev, `<div class="t">${esc(byId.get(e.a).data.name)} — ${esc(byId.get(e.b).data.name)}</div>` +
        `<div class="r"><span>${fmtN(e.w)} ${plural(e.w, UNIT)}</span></div>`))
      .on('mouseleave', ui.hideTip);
    const neighbors = new Map(g.leaves.map(l => [l.id, []]));
    edges.forEach(e => { neighbors.get(e.a).push(e); neighbors.get(e.b).push(e); });

    const leaf = svg.append('g').selectAll('g').data(rootNode.leaves()).join('g').attr('class', 'leaf')
      .attr('transform', d => `rotate(${d.x * 180 / Math.PI - 90}) translate(${d.y + 10},0)`);
    leaf.append('text').attr('dy', '0.31em')
      .attr('text-anchor', d => d.x < Math.PI ? 'start' : 'end')
      .attr('transform', d => d.x >= Math.PI ? 'rotate(180)' : null)
      .text(d => d.data.name.length > 28 ? d.data.name.slice(0, 27) + '…' : d.data.name);
    // зона наведения — поверх подписи, снаружи круга на обеих половинах (в системе координат узла подпись идёт по +x)
    leaf.append('rect').attr('x', -4).attr('y', -font / 2 - 1).attr('width', labelR - 6).attr('height', font + 2)
      .attr('fill', 'transparent')
      .on('mouseenter', (ev, d) => focus(d.data.leaf.id))
      .on('mousemove', (ev, d) => {
        const l = d.data.leaf, es = neighbors.get(l.id).slice().sort((a, b) => b.w - a.w);
        const other = e => byId.get(e.a === l.id ? e.b : e.a).data.name;
        ui.showTip(ev, `<div class="t">${esc(l.label)}</div><div class="g">${esc(g.groupWord)}: ${esc(l.group)}${l.note ? ' · ' + esc(l.note) : ''}</div>` +
          (opts.partnersOnly ? (es.length ? '<div class="g">Совместных заказов</div>' : '') : `<div class="r"><span>Заказов</span><b>${fmtN(l.n)}</b></div>`) +
          (es.length ? es.slice(0, 6).map(e => `<div class="r"><span>${esc(other(e))}</span><b>${fmtN(e.w)}</b></div>`).join('') +
            (es.length > 6 ? `<div class="g">и ещё ${es.length - 6}</div>` : '') : '<div class="g">связей не слабее порога нет</div>'));
      })
      .on('mouseleave', () => { focus(pin); ui.hideTip(); });

    function focus(id) {
      if (!id || !neighbors.has(id)) { links.classed('hl', false).classed('dim', false); leaf.select('text').classed('on', false).classed('off', false); return; }
      const near = new Set([id]);
      neighbors.get(id).forEach(e => { near.add(e.a); near.add(e.b); });
      links.classed('hl', e => e.a === id || e.b === id).classed('dim', e => e.a !== id && e.b !== id);
      links.filter(e => e.a === id || e.b === id).raise();
      leaf.select('text').classed('on', d => near.has(d.data.leaf.id)).classed('off', d => !near.has(d.data.leaf.id));
    }
    const pin = opts.pin && neighbors.has(opts.pin) ? opts.pin : null;
    focus(pin);

    el.replaceChildren(svg.node());
    const name = id => byId.get(id).data.name;
    opts.table.innerHTML = `<table><thead><tr><th>Связь</th><th class="n">Общих заказов</th></tr></thead><tbody>` +
      g.edges.slice().sort((a, b) => b.w - a.w).slice(0, 60).map(e => `<tr><td>${esc(name(e.a))} — ${esc(name(e.b))}</td><td class="n">${e.w}</td></tr>`).join('') +
      `</tbody></table>`;
    return { shown: edges.length, total: g.edges.length, maxW, n };
  }

  A.bundling = { draw };
})(typeof window !== 'undefined' ? window : globalThis);
