"""
Локальная страница для проверки карты глазами: карта + таблица «задача → топонимы»
с источником координат и расхождением с оценкой модели + справочник цветов карты.

    python collect.py --dry-run -v        # обновить %LOCALAPPDATA%\\gantt-collector\\geo-review.json
    python geo_review.py                  # → in/geo-review.html (в .gitignore: там реальные задачи)
Открыть через локальный сервер из корня репозитория: http://localhost:8766/in/geo-review.html
"""
import html
import json
import os
import sys
from pathlib import Path

import geo

REPO = Path(__file__).resolve().parent.parent.parent
SRC = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "gantt-collector" / "geo-review.json"
OUT = REPO / "in" / "geo-review.html"

SRC_LABEL = {"cache": "кэш", "nominatim": "Nominatim", "llm": "оценка модели", "basemap": "полигон страны"}

STYLES = [
    ("--map-sea", "море и фон за картой"),
    ("--map-land", "суша"),
    ("--map-border", "границы стран и береговая линия"),
    ("--map-outline", "рамка мира (края проекции)"),
    ("--map-today", "точка «сегодня», её пульс, контур страны под курсором"),
    ("--map-old", "точка «вчера–позавчера»"),
    ("--map-old-opacity", "непрозрачность точки «вчера–позавчера» (0…1)"),
    ("--map-halo", "белый ободок вокруг точек"),
    ("--map-hover", "кольцо вокруг точки под курсором"),
    ("--map-country-today", "заливка страны «сегодня»"),
    ("--map-country-today-line", "контур страны «сегодня»"),
    ("--map-country-old", "заливка страны «вчера–позавчера»"),
]

e = html.escape


def rows_html(items):
    out = []
    for it in items:
        tops = []
        for t in it["toponyms"]:
            llm, got = t["llm"], t["got"]
            if not got:
                tops.append(f'<li class="miss">{e(llm["name"])} — <i>не найдено</i></li>')
                continue
            src = got.get("_src", "")
            d = ""
            if "lat" in got and isinstance(llm.get("lat"), (int, float)):
                dist = geo.km([llm["lat"], llm["lon"]], [got["lat"], got["lon"]])
                cls = "far" if dist > 50 else ""
                d = f' <span class="km {cls}">{dist:.0f} км</span>' if src != "llm" else ""
            where = f'{got["lat"]:.3f}, {got["lon"]:.3f}' if "lat" in got else got.get("iso", "")
            tops.append(
                f'<li><b>{e(llm["name"])}</b> <span class="kind">{e(llm["kind"])}</span>'
                f'{" · " + e(llm["macro"]) if llm.get("macro") else ""}'
                f' <span class="src {src}">{SRC_LABEL.get(src, src)}</span>{d}'
                f' <span class="coord">{where}</span></li>')
        meta = " / ".join(it["themes"]) + (f' · {e(it["conflict"])}' if it["conflict"] else "")
        out.append(
            f'<tr><td class="id">{e(it["id"])}</td><td class="t">{e(it["start"][:16])}</td>'
            f'<td><div class="nm">{e(it["name"])}</div><div class="meta">{e(it["project"])} · {e(it["product"])}</div></td>'
            f'<td><div>{e(meta)}</div><div class="meta">{e(it["sentiment"])}</div></td>'
            f'<td><ul>{"".join(tops) or "<li class=miss>—</li>"}</ul></td></tr>')
    return "\n".join(out)


def main():
    if not SRC.exists():
        sys.exit(f"Нет {SRC} — сначала python collect.py --dry-run -v")
    data = json.loads(SRC.read_text(encoding="utf-8"))
    items = data["items"]
    geo_pub = {"v": 1, "items": [
        {"id": it["id"], "start": it["start"],
         "toponyms": [{k: v for k, v in t["got"].items() if not k.startswith("_")} for t in it["toponyms"] if t["got"]]}
        for it in items]}
    n = sum(len(it["toponyms"]) for it in items)
    by_src = {}
    for it in items:
        for t in it["toponyms"]:
            s = (t["got"] or {}).get("_src", "miss")
            by_src[s] = by_src.get(s, 0) + 1
    stats = " · ".join(f"{SRC_LABEL.get(k, 'не найдено')}: {v}" for k, v in sorted(by_src.items(), key=lambda x: -x[1]))
    styles = "\n".join(
        f'<tr><td><span class="big" style="background:var({v})"></span></td><td><code>{v}</code></td>'
        f'<td class="val" data-var="{v}"></td><td>{e(desc)}</td></tr>' for v, desc in STYLES)

    page = f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<base href="../">
<title>Проверка карты</title>
<link rel="stylesheet" href="css/styles.css">
<style>
  body {{ display:block; }}
  .wrap {{ padding: 12px 16px 32px; }}
  h1 {{ margin: 0 0 4px; font-size: 22px; color: var(--header); }}
  h2 {{ margin: 24px 0 8px; font-size: 17px; color: var(--header); }}
  .sub {{ color: var(--gray); font-size: 13px; }}
  table.rv {{ border-collapse: collapse; width: 100%; font-size: 12.5px; background: #fff; }}
  table.rv th, table.rv td {{ border: 1px solid var(--line); padding: 4px 6px; vertical-align: top; text-align: left; }}
  table.rv th {{ background: var(--header); color: #fff; position: sticky; top: 0; }}
  .id, .t {{ white-space: nowrap; }}
  .nm {{ font-weight: 700; }}
  .meta {{ color: var(--gray); font-size: 11.5px; }}
  ul {{ margin: 0; padding-left: 16px; }}
  .kind {{ color: var(--gray); font-size: 11px; }}
  .src {{ font-size: 11px; padding: 0 5px; border-radius: 3px; background: #E5E7EB; }}
  .src.cache {{ background: #D8EDE0; }} .src.nominatim {{ background: #DBE7F5; }}
  .src.llm {{ background: #F3C6C0; }} .src.basemap {{ background: #EDE3D1; }}
  .km {{ font-size: 11px; color: var(--gray); }} .km.far {{ color: #B42318; font-weight: 700; }}
  .coord {{ font-size: 11px; color: #9CA3AF; }}
  .miss {{ color: #B42318; }}
  .big {{ display:inline-block; width: 44px; height: 22px; border: 1px solid var(--line); }}
  .val {{ font-family: Consolas, monospace; font-size: 12px; }}
  .geo {{ margin-top: 8px; }}
</style></head>
<body><div class="wrap">
<h1>Проверка карты топонимов</h1>
<div class="sub">Данные Bitrix на {e(data.get("now") or "")} · модель {e(data.get("model") or "")} · задач {len(items)},
топонимов {n} ({stats}). Локальная страница, никуда не публикуется.</div>

<section id="geo" class="geo" hidden>
  <div class="geo-head"><h2 style="margin:0">Карта</h2><span id="geo-info" class="geo-info"></span></div>
  <div id="geo-stage" class="geo-stage">
    <canvas id="geo-canvas"></canvas>
    <div class="geo-zoom">
      <button id="geo-zin" type="button" title="Приблизить">+</button>
      <button id="geo-zout" type="button" title="Отдалить">−</button>
      <button id="geo-fit" type="button" title="Показать все топонимы">⤢</button>
    </div>
    <div id="geo-tip" class="geo-tip" hidden></div>
  </div>
  <p class="legend geo-legend">
    <span class="gdot today"></span>сегодня (с 04:00) <span class="gdot old"></span>вчера и позавчера.
    <span class="sw" style="background:var(--map-country-today);box-shadow:inset 0 0 0 1px var(--map-country-today-line)"></span>страна сегодня
    <span class="sw" style="background:var(--map-country-old)"></span>страна раньше. Пунктирный ободок — координаты по оценке модели.
  </p>
</section>

<h2>Цвета карты</h2>
<div class="sub">Меняются в <code>css/styles.css</code>, блок «Карта топонимов» (переменные <code>--map-*</code>).</div>
<table class="rv" style="width:auto"><tr><th>Образец</th><th>Переменная</th><th>Значение</th><th>Что красит</th></tr>
{styles}</table>

<h2>Задачи и топонимы</h2>
<div class="sub">Источник координат: <span class="src cache">кэш</span> <span class="src nominatim">Nominatim</span>
<span class="src basemap">полигон страны</span> <span class="src llm">оценка модели</span> (не подтверждено геокодером).
«км» — насколько найденная точка отстоит от оценки модели; красным — больше 50 км.</div>
<table class="rv"><tr><th>ID</th><th>Регистрация</th><th>Задача</th><th>Тема / тональность</th><th>Топонимы</th></tr>
{rows_html(items)}
</table>
</div>
<script src="js/model.js"></script>
<script src="js/map/geo-model.js"></script>
<script src="js/map/geo-map.js"></script>
<script>
  const cs = getComputedStyle(document.documentElement);
  document.querySelectorAll('.val').forEach(td => td.textContent = cs.getPropertyValue(td.dataset.var).trim());
  const now = GanttModel.parseDt({json.dumps(data.get("now") or "")}) || new Date();
  GanttMap.show({json.dumps(geo_pub, ensure_ascii=False)}, now);
</script>
</body></html>"""
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(page, encoding="utf-8")
    print(f"{OUT}  (задач {len(items)}, топонимов {n}: {stats})")


if __name__ == "__main__":
    main()
