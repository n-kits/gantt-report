/*
 * Модель карты топонимов: раздел geo из живых данных → точки и страны для отрисовки.
 *
 * geo = { items: [{ id, start: 'ДД.ММ.ГГГГ ЧЧ:ММ:СС', toponyms: [
 *           { name, kind: 'country'|'water'|'settlement'|…, iso?, lat?, lon?, approx? } ] }] }
 *
 * «Сегодня» — с 04:00 (как ось ленты): до 04:00 утра сегодняшним считается вчерашний день.
 */
(function (root) {
  'use strict';

  const DAY_START_HOUR = 4;

  function dayStart(now) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DAY_START_HOUR);
    if (now < d) d.setDate(d.getDate() - 1);
    return d;
  }

  function parseStart(s) {
    if (s instanceof Date) return s;
    const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || ''));
    return m ? new Date(+m[3], m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) : null;
  }

  const normName = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

  /*
   * → { points: [{ key, name, lat, lon, count, today, approx }],
   *     countries: [{ iso, name, count, today }] }
   * count — число разных задач с этим топонимом; today — есть хотя бы одна сегодняшняя.
   * Одинаковые топонимы сливаются по названию (без регистра, ё = е) и близким координатам.
   */
  function aggregate(geo, now) {
    const from = dayStart(now);
    const points = new Map();
    const countries = new Map();
    for (const it of (geo && geo.items) || []) {
      const start = parseStart(it.start);
      const today = !!start && start >= from;
      const seen = new Set();   // один топоним дважды в одной задаче считаем один раз
      for (const t of it.toponyms || []) {
        let key, bucket, init;
        if (t.kind === 'country' && t.iso) {
          key = t.iso;
          bucket = countries;
          init = () => ({ iso: t.iso, name: t.name, count: 0, today: false });
        } else if (Number.isFinite(t.lat) && Number.isFinite(t.lon)) {
          key = `${normName(t.name)}|${t.lat.toFixed(1)}|${t.lon.toFixed(1)}`;
          bucket = points;
          init = () => ({ key, name: t.name, lat: t.lat, lon: t.lon, count: 0, today: false, approx: !!t.approx });
        } else {
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        if (!bucket.has(key)) bucket.set(key, init());
        const x = bucket.get(key);
        x.count++;
        x.today = x.today || today;
        if (bucket === points && !t.approx) x.approx = false;
      }
    }
    // крупные рисуются первыми, чтобы мелкие были сверху; сегодняшние — поверх вчерашних
    const order = (a, b) => (a.today - b.today) || (b.count - a.count);
    return {
      points: Array.from(points.values()).sort(order),
      countries: Array.from(countries.values()).sort(order),
    };
  }

  // Радиус точки в px: 1 задача — 4, дальше растёт как корень из числа задач.
  const radius = count => Math.min(16, 4 + 3 * Math.sqrt(Math.max(0, count - 1)));

  root.GanttGeo = { aggregate, dayStart, parseStart, radius, DAY_START_HOUR };
})(typeof window !== 'undefined' ? window : globalThis);
