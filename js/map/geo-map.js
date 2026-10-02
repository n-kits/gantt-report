/*
 * Карта топонимов под лентой: canvas, проекция Natural Earth, подложка — полигоны
 * стран из data/basemap.json (tools/build_basemap.py).
 *
 * Масштаб — колесо (к курсору), двойной клик, щипок, кнопки; перетаскивание — мышью.
 * Сегодняшние точки пульсируют; анимация крутится, только пока они есть, вкладка
 * видна и не включено «уменьшение движения».
 */
(function (root) {
  'use strict';

  const G = root.GanttGeo;
  const BASEMAP_URL = 'data/basemap.json';

  // Цвета — CSS-переменные --map-* (css/styles.css, блок «Карта топонимов»); здесь запасные.
  const COLORS = {
    sea: '#E6EDF1',
    land: '#FAF8F3',
    border: '#C9C3B6',
    today: '#16A34A',
    old: '#8A919C',
    old2: '#C3C8CF',
    oldOpacity: 0.75,
    halo: '#FFFFFF',
    hover: '#1F2937',
    countryToday: 'rgba(22, 163, 74, .26)',
    countryTodayLine: 'rgba(22, 163, 74, .75)',
    countryOld: 'rgba(107, 114, 128, .12)',
    countryOldLine: 'rgba(107, 114, 128, .55)',
  };
  const PULSE_MS = 2400;

  /*
   * Вид точки. Основной — halves (половинки, см. ниже). В архиве (параметр ?points=… в адресе):
   *   core — серый круг по всем задачам за три дня и зелёное ядро по сегодняшним;
   *   dot  — круг: размер по всем задачам, цвет «сегодня» / «раньше»;
   *   pie  — сектора: доля задач сегодня / вчера / позавчера;
   *   ring — кольцо из дуг по дням, центр зелёный, если место есть сегодня.
   * Раздельные (без общей суммы за три дня: «сегодня» и «вчера–позавчера» — каждый своим размером):
   *   split  — два круга в одном месте, больший снизу;
   *   pair   — два круга рядом: зелёный слева, серый справа;
   *   halves — половинки: левая зелёная, правая серая, у каждой свой радиус.
   */
  const POINT_STYLES = ['core', 'dot', 'pie', 'ring', 'split', 'pair', 'halves'];
  const SEPARATE = ['split', 'pair', 'halves'];
  const DEFAULT_POINT_STYLE = 'halves';
  let pointStyle = (() => {
    const v = new URLSearchParams(location.search).get('points');
    return POINT_STYLES.includes(v) ? v : DEFAULT_POINT_STYLE;
  })();
  document.documentElement.dataset.points = pointStyle;   // легенда показывает пояснение к этому виду

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of Object.keys(COLORS)) {
      const v = cs.getPropertyValue('--map-' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())).trim();
      if (v) COLORS[k] = typeof COLORS[k] === 'number' ? parseFloat(v) : v;
    }
  }

  // --- проекция (как в ships_routes_map) ------------------------------------
  function rawNE(lon, lat) {
    const l = lon * Math.PI / 180, p = lat * Math.PI / 180, p2 = p * p, p4 = p2 * p2;
    const x = l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
    const y = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
    return [x, y];
  }
  const SC = 500 / rawNE(180, 0)[0];
  const P = (lon, lat) => { const r = rawNE(lon, lat); return [r[0] * SC, -r[1] * SC]; };
  const HALF_H = -P(0, 90)[1];

  const el = {
    box: document.getElementById('geo'),
    stage: document.getElementById('geo-stage'),
    canvas: document.getElementById('geo-canvas'),
    tip: document.getElementById('geo-tip'),
    info: document.getElementById('geo-info'),
  };
  if (!el.box) return;
  const ctx = el.canvas.getContext('2d');
  const base = document.createElement('canvas');
  const baseCtx = base.getContext('2d');
  let baseDirty = true;
  let onScreen = true;
  if (root.IntersectionObserver) {
    new IntersectionObserver(es => { onScreen = es[0].isIntersecting; dirty = true; }).observe(el.stage);
  }
  const reduceMotion = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  let W = 0, H = 0, dpr = 1;
  let k = 1, k0 = 1, tx = 0, ty = 0;           // экран = база * k + (tx, ty)
  let basemap = null;                           // { paths: Map iso → Path2D, land: Path2D }
  let basemapLoading = null;
  let data = { points: [], countries: [] };
  let proj = [];                                // точки в базовых координатах
  let dirty = true;
  let userMoved = false;
  let hover = null;

  // --- подложка ---------------------------------------------------------------
  function loadBasemap() {
    if (basemapLoading) return basemapLoading;
    basemapLoading = fetch(BASEMAP_URL)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(json => {
        const land = new Path2D();
        const paths = new Map();
        for (const c of json.countries) {
          const p = new Path2D();
          for (const poly of c.polys) {
            for (const ring of poly) {
              for (let i = 0; i < ring.length; i += 2) {
                const q = P(ring[i], ring[i + 1]);
                i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]);
              }
              p.closePath();
            }
          }
          land.addPath(p);
          paths.set(c.iso, { path: p, name: c.name, bbox: bboxOf(c.polys) });
        }
        basemap = { land, paths };
        if (!userMoved) fit();
        baseDirty = dirty = true;
      })
      .catch(e => {
        console.error(e);
        el.info.textContent = `Не удалось загрузить подложку карты (${e.message}).`;
      });
    return basemapLoading;
  }

  function bboxOf(polys) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polys) {
      const ring = poly[0];
      for (let i = 0; i < ring.length; i += 2) {
        const q = P(ring[i], ring[i + 1]);
        x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]);
        y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
      }
    }
    return [x0, y0, x1, y1];
  }

  // --- вид ------------------------------------------------------------------
  function resize() {
    const r = el.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const wasFit = !userMoved;
    W = r.width; H = r.height; dpr = root.devicePixelRatio || 1;
    el.canvas.width = base.width = Math.round(W * dpr);
    el.canvas.height = base.height = Math.round(H * dpr);
    k0 = Math.min(W / 1010, H / (HALF_H * 2 + 16));
    if (wasFit) fit(); else clampView();
    baseDirty = dirty = true;
  }

  // Показать все точки (страны — только если точек нет); вся карта, если данных нет.
  function fit() {
    let b = null;
    const add = (x0, y0, x1, y1) => {
      b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1];
    };
    for (const p of proj) add(p.x, p.y, p.x, p.y);
    if (!b && basemap) {
      for (const c of data.countries) { const e = basemap.paths.get(c.iso); if (e) add(...e.bbox); }
    }
    if (!b) {
      k = k0; tx = W / 2; ty = H / 2;
    } else {
      const MIN_SPAN = 40;                       // не приближать сильнее ~15° по ширине
      const w = Math.max(b[2] - b[0], MIN_SPAN), h = Math.max(b[3] - b[1], MIN_SPAN * H / W);
      k = Math.min((W - 80) / w, (H - 80) / h);
      tx = W / 2 - (b[0] + b[2]) / 2 * k;
      ty = H / 2 - (b[1] + b[3]) / 2 * k;
    }
    userMoved = false;
    clampView();
    baseDirty = dirty = true;
  }

  function clampView() {
    k = Math.max(k0 * 0.9, Math.min(k, k0 * 120));
    const hw = 500 * k, hh = HALF_H * k, m = 60;
    tx = Math.min(W - m + hw, Math.max(m - hw, tx));
    ty = Math.min(H - m + hh, Math.max(m - hh, ty));
  }

  function zoomAt(f, sx, sy) {
    const nk = Math.max(k0 * 0.9, Math.min(k * f, k0 * 120));
    f = nk / k;
    tx = sx - (sx - tx) * f;
    ty = sy - (sy - ty) * f;
    k = nk;
    userMoved = true;
    clampView();
    baseDirty = dirty = true;
  }

  // --- отрисовка -------------------------------------------------------------
  const hasToday = () => data.points.some(p => p.today);
  const animating = () => hasToday() && !reduceMotion.matches && document.visibilityState === 'visible';

  // подложка и страны — в отдельный холст, перерисовка только при смене вида/данных
  function drawBase() {
    const ctx = baseCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.sea;
    ctx.fillRect(0, 0, W, H);
    if (!basemap) return;

    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    ctx.fillStyle = COLORS.land;
    ctx.fill(basemap.land, 'evenodd');

    // страны: сначала вчерашние, потом сегодняшние
    for (const c of data.countries) {
      const e = basemap.paths.get(c.iso);
      if (!e) continue;
      ctx.fillStyle = c.today ? COLORS.countryToday : COLORS.countryOld;
      ctx.fill(e.path, 'evenodd');
    }
    ctx.lineWidth = 0.5 / k;
    ctx.strokeStyle = COLORS.border;
    ctx.stroke(basemap.land);
    for (const c of data.countries) {
      const e = basemap.paths.get(c.iso);
      if (!e || !c.today) continue;
      ctx.lineWidth = 1.2 / k;
      ctx.strokeStyle = COLORS.countryTodayLine;
      ctx.stroke(e.path);
    }
    // страна под курсором — контуром своего статуса, чуть толще обычного
    if (hover && hover.iso) {
      const e = basemap.paths.get(hover.iso);
      if (e) {
        ctx.lineWidth = 2 / k;
        ctx.strokeStyle = hover.today ? COLORS.countryTodayLine : COLORS.countryOldLine;
        ctx.stroke(e.path);
      }
    }
  }

  function draw(t) {
    if (baseDirty) { baseDirty = false; drawBase(); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    if (!basemap) return;

    // точки — в экранных координатах, размер не зависит от масштаба
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const phase = animating() ? (t % PULSE_MS) / PULSE_MS : null;
    for (const p of proj) {
      const sx = p.x * k + tx, sy = p.y * k + ty;
      const r = extent(p);
      if (sx < -r * 4 || sy < -r * 4 || sx > W + r * 4 || sy > H + r * 4) continue;
      drawPoint(p, sx, sy, r, phase);
      if (p.approx) {            // приблизительные координаты — пунктирный ободок
        ctx.setLineDash([2, 2]); ctx.strokeStyle = p.today ? COLORS.today : COLORS.old; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(sx, sy, r + 3, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
      }
      if (hover && hover.key === p.key) {
        ctx.strokeStyle = COLORS.hover; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, r + 3, 0, 2 * Math.PI); ctx.stroke();
      }
    }
  }

  // расходящееся и тающее кольцо, как у зелёной точки «живых данных»
  function pulse(sx, sy, r, phase) {
    if (phase == null) return;
    const e = 1 - Math.pow(1 - Math.min(1, phase / 0.7), 3);
    ctx.globalAlpha = 0.5 * (1 - e);
    ctx.fillStyle = COLORS.today;
    ctx.beginPath(); ctx.arc(sx, sy, r * (1 + 1.6 * e), 0, 2 * Math.PI); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function disc(sx, sy, r, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 2 * Math.PI); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function halo(sx, sy, r, width) {
    ctx.strokeStyle = COLORS.halo;
    ctx.lineWidth = width || 1.5;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 2 * Math.PI); ctx.stroke();
  }

  const DAY_COLORS = () => [COLORS.today, COLORS.old, COLORS.old2];

  const days = p => p.byDay || [p.today ? p.count : 0, p.today ? 0 : p.count, 0];

  // радиусы «сегодня» и «вчера–позавчера» для раздельных видов (0 — части нет)
  function sepRadii(p) {
    const d = days(p);
    return [d[0] ? G.radius(d[0]) : 0, d[1] + d[2] ? G.radius(d[1] + d[2]) : 0];
  }

  // радиус, в который вписан значок точки: для наведения, ободков и отсечения
  function extent(p) {
    if (!SEPARATE.includes(pointStyle)) return G.radius(p.count);
    const [rt, ro] = sepRadii(p);
    if (pointStyle === 'pair' && rt && ro) return rt + ro;
    if (pointStyle === 'split' && rt && ro) return Math.max(rt, ro, Math.min(rt, ro) + 2);
    return Math.max(rt, ro);
  }

  function halfDisc(sx, sy, r, left, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.arc(sx, sy, r, left ? Math.PI / 2 : -Math.PI / 2, left ? 3 * Math.PI / 2 : Math.PI / 2);
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS.halo; ctx.lineWidth = 1.25; ctx.stroke();
  }

  function drawPoint(p, sx, sy, r, phase) {
    const d = days(p);
    if (SEPARATE.includes(pointStyle)) {
      let [rt, ro] = sepRadii(p);
      if (pointStyle === 'split' && rt && ro) {
        // нижний (больший) круг — хотя бы на 2 px больше верхнего, иначе при равных числах он не виден
        if (ro < rt) rt = Math.max(rt, ro + 2); else ro = Math.max(ro, rt + 2);
      }
      const green = (x, y) => { pulse(x, y, rt, phase); disc(x, y, rt, COLORS.today, 1); halo(x, y, rt); };
      const grey = (x, y) => { disc(x, y, ro, COLORS.old, COLORS.oldOpacity); halo(x, y, ro); };
      if (pointStyle === 'split') {
        // оба круга в одной точке: больший снизу, меньший сверху — видно оба
        if (rt && ro && ro < rt) { green(sx, sy); grey(sx, sy); }   // сегодня больше — серый сверху
        else { if (ro) grey(sx, sy); if (rt) green(sx, sy); }
      } else if (pointStyle === 'pair') {
        // касаются друг друга в самой точке: зелёный слева, серый справа
        if (rt && ro) { green(sx - rt, sy); grey(sx + ro, sy); }
        else if (rt) green(sx, sy);
        else grey(sx, sy);
      } else {
        // половинки с общим центром, у каждой свой радиус; место только в один из дней — целый круг
        if (!(rt && ro)) {
          if (rt) green(sx, sy); else grey(sx, sy);
        } else {
          pulse(sx, sy, rt, phase);
          halfDisc(sx, sy, rt, true, COLORS.today, 1);
          halfDisc(sx, sy, ro, false, COLORS.old, COLORS.oldOpacity);
          ctx.strokeStyle = COLORS.halo; ctx.lineWidth = 1.25;   // разделитель
          ctx.beginPath(); ctx.moveTo(sx, sy - Math.max(rt, ro)); ctx.lineTo(sx, sy + Math.max(rt, ro)); ctx.stroke();
        }
      }
    } else if (pointStyle === 'core') {
      // серый круг — все задачи за три дня, зелёное ядро — сегодняшние
      disc(sx, sy, r, COLORS.old, COLORS.oldOpacity);
      halo(sx, sy, r);
      if (d[0]) {
        const rc = Math.min(r, G.radius(d[0]));
        pulse(sx, sy, rc, phase);
        disc(sx, sy, rc, COLORS.today, 1);
        if (rc < r) halo(sx, sy, rc, 1);
      }
    } else if (pointStyle === 'pie') {
      // сектора по дням, от 12 часов по часовой стрелке: сегодня, вчера, позавчера
      if (p.today) pulse(sx, sy, r, phase);
      const colors = DAY_COLORS();
      let a = -Math.PI / 2;
      for (let i = 0; i < 3; i++) {
        if (!d[i]) continue;
        const b = a + 2 * Math.PI * d[i] / p.count;
        ctx.fillStyle = colors[i];
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.arc(sx, sy, r, a, b); ctx.closePath(); ctx.fill();
        a = b;
      }
      halo(sx, sy, r);
    } else if (pointStyle === 'ring') {
      // дуги по дням по краю, центр — зелёный, если место есть сегодня
      if (p.today) pulse(sx, sy, r, phase);
      const w = Math.max(2.5, r * 0.42);
      const colors = DAY_COLORS();
      disc(sx, sy, r, COLORS.halo, 1);
      let a = -Math.PI / 2;
      ctx.lineWidth = w;
      for (let i = 0; i < 3; i++) {
        if (!d[i]) continue;
        const b = a + 2 * Math.PI * d[i] / p.count;
        ctx.strokeStyle = colors[i];
        ctx.beginPath(); ctx.arc(sx, sy, r - w / 2, a, b); ctx.stroke();
        a = b;
      }
      disc(sx, sy, Math.max(1.5, r - w - 1), p.today ? COLORS.today : COLORS.old, p.today ? 1 : COLORS.oldOpacity);
      halo(sx, sy, r);
    } else {
      pulse(sx, sy, r, p.today ? phase : null);
      disc(sx, sy, r, p.today ? COLORS.today : COLORS.old, p.today ? 1 : COLORS.oldOpacity);
      halo(sx, sy, r);
    }
  }

  // пульс — ~30 кадров/с и только пока карта на экране
  let lastFrame = 0;
  function loop(t) {
    const pulse = animating() && onScreen && t - lastFrame > 33;
    if (dirty || pulse) { dirty = false; lastFrame = t; draw(t); }
    root.requestAnimationFrame(loop);
  }

  // --- наведение ------------------------------------------------------------
  function pick(mx, my) {
    for (let i = proj.length - 1; i >= 0; i--) {       // сверху вниз
      const p = proj[i];
      const dx = p.x * k + tx - mx, dy = p.y * k + ty - my, r = extent(p) + 3;
      if (dx * dx + dy * dy <= r * r) return p;
    }
    if (!basemap) return null;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    for (let i = data.countries.length - 1; i >= 0; i--) {
      const c = data.countries[i];
      const e = basemap.paths.get(c.iso);
      if (e && ctx.isPointInPath(e.path, mx * dpr, my * dpr, 'evenodd')) return c;
    }
    return null;
  }

  function showTip(x, mx, my) {
    if (!x) { el.tip.hidden = true; return; }
    const name = x.name || (basemap && basemap.paths.get(x.iso) || {}).name || x.iso;
    // «Москва 9 / 23»: задач с этим местом сегодня (с 04:00) / вчера–позавчера (расшифровка — в легенде)
    const d = days(x);
    el.tip.textContent = `${name} ${d[0]} / ${d[1] + d[2]}`;
    el.tip.hidden = false;
    const w = el.tip.offsetWidth, h = el.tip.offsetHeight;
    el.tip.style.left = Math.min(W - w - 4, mx + 12) + 'px';
    el.tip.style.top = (my + 14 + h > H ? my - h - 10 : my + 14) + 'px';
  }

  function setHover(x, mx, my) {
    if (x !== hover) { hover = x; baseDirty = dirty = true; }
    showTip(x, mx, my);
    el.canvas.style.cursor = x ? 'pointer' : '';
  }

  // --- ввод -----------------------------------------------------------------
  const ptrs = new Map();
  let drag = null, pinch = null;
  el.canvas.addEventListener('pointerdown', e => {
    el.canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (ptrs.size === 1) drag = { x: e.offsetX, y: e.offsetY, tx, ty, moved: 0 };
    else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; drag = null; }
  });
  el.canvas.addEventListener('pointermove', e => {
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pinch && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch.d = d;
      return;
    }
    if (drag) {
      const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
      drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
      if (drag.moved > 3) {
        tx = drag.tx + dx; ty = drag.ty + dy; userMoved = true;
        clampView(); baseDirty = dirty = true;
        el.canvas.classList.add('drag');
        setHover(null);
      }
    } else if (e.pointerType === 'mouse') {
      setHover(pick(e.offsetX, e.offsetY), e.offsetX, e.offsetY);
    }
  });
  const endPtr = e => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (!ptrs.size) drag = null;
    el.canvas.classList.remove('drag');
  };
  el.canvas.addEventListener('pointerup', endPtr);
  el.canvas.addEventListener('pointercancel', endPtr);
  el.canvas.addEventListener('pointerleave', () => setHover(null));
  el.canvas.addEventListener('wheel', e => {
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
  }, { passive: false });
  el.canvas.addEventListener('dblclick', e => zoomAt(2, e.offsetX, e.offsetY));
  document.getElementById('geo-zin').onclick = () => zoomAt(1.6, W / 2, H / 2);
  document.getElementById('geo-zout').onclick = () => zoomAt(1 / 1.6, W / 2, H / 2);
  document.getElementById('geo-fit').onclick = () => fit();

  root.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { dirty = true; });

  // --- API ------------------------------------------------------------------
  function describe() {
    const nP = data.points.length, nC = data.countries.length;
    const paused = lastGeo && lastGeo.llm === false
      ? ` Анализ новых задач приостановлен${lastGeo.waiting ? ` — ждут ${lastGeo.waiting}` : ''}.` : '';
    return describeCounts(nP, nC) + paused;
  }

  function describeCounts(nP, nC) {
    if (!nP && !nC) return 'Топонимов в задачах за три дня не найдено.';
    const today = data.points.filter(p => p.today).length + data.countries.filter(c => c.today).length;
    return `Топонимов: ${nP + nC}, из них сегодня: ${today}.`;
  }

  let started = false;
  let lastGeo = null;
  // в 04:00 «сегодняшние» становятся вчерашними — пересчитываем без новых данных
  setInterval(() => {
    if (lastGeo && !el.box.hidden) setData(lastGeo, new Date());
  }, 60 * 1000);

  function setData(geo, now) {
    data = G.aggregate(geo, now);
    proj = data.points.map(p => { const q = P(p.lon, p.lat); return Object.assign({ x: q[0], y: q[1] }, p); });
    if (hover) hover = (hover.key ? proj.find(p => p.key === hover.key) : data.countries.find(c => c.iso === hover.iso)) || null;
    el.info.textContent = describe();
    baseDirty = dirty = true;
  }

  root.GanttMap = {
    // geo — раздел живых данных; null — скрыть карту (загружен файл / данных нет)
    show(geo, now) {
      lastGeo = geo || null;
      if (!geo) { el.box.hidden = true; return; }
      readColors();
      el.box.hidden = false;
      setData(geo, now || new Date());
      resize();
      if (!userMoved) fit();
      loadBasemap();
      if (!started) { started = true; root.requestAnimationFrame(loop); }
      baseDirty = dirty = true;
    },
    hide() { el.box.hidden = true; },
    setPointStyle(v) {
      if (!POINT_STYLES.includes(v)) return;
      pointStyle = v;
      document.documentElement.dataset.points = v;
      dirty = true;
    },
    get pointStyle() { return pointStyle; },
    // для проверки без видимой вкладки (rAF в фоне не крутится)
    redraw(t) { draw(t == null ? 0 : t); },
    whenReady: () => basemapLoading,
  };
})(window);
