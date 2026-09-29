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


def main():
    if not SRC.exists():
        sys.exit(f"Нет {SRC} — сначала python collect.py --dry-run -v")
    data = json.loads(SRC.read_text(encoding="utf-8"))
    items = data["items"]
    n = sum(len(it["toponyms"]) for it in items)
    by_src = {}
    for it in items:
        for t in it["toponyms"]:
            by_src[t.get("src", "")] = by_src.get(t.get("src", ""), 0) + 1
    stats = " · ".join(f"{SRC_LABEL.get(k, k)}: {v}" for k, v in sorted(by_src.items(), key=lambda x: -x[1]))
    styles = "\n".join(
        f'<tr><td><span class="big" style="background:var({v})"></span></td><td><code>{v}</code></td>'
        f'<td class="val" data-var="{v}"></td><td>{e(desc)}</td></tr>' for v, desc in STYLES)
    # «</» внутри <script> закрыл бы тег раньше времени
    geo_json = json.dumps({"v": 1, "items": items}, ensure_ascii=False).replace("</", r"<\/")

    page = f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<base href="../">
<title>Проверка карты</title>
<link rel="stylesheet" href="css/styles.css">
<style>
  body {{ display:block; }}
  .wrap {{ padding: 12px 16px 32px; }}
  h1 {{ margin: 0 0 4px; font-size: 22px; color: var(--header); }}
  .sub {{ color: var(--gray); font-size: 13px; }}
  .big {{ display:inline-block; width: 44px; height: 22px; border: 1px solid var(--line); }}
  .val {{ font-family: Consolas, monospace; font-size: 12px; }}
</style></head>
<body><div class="wrap">
<h1>Проверка карты топонимов</h1>
<div class="sub">Данные Bitrix на {e(data.get("now") or "")} · модель {e(data.get("model") or "")} · задач {len(items)},
топонимов {n} ({stats}). Локальная страница, никуда не публикуется.</div>

<section id="geo" class="geo" hidden>
  <div class="geo-head"><h2 class="geo-h2" style="margin:0">Карта</h2><span id="geo-info" class="geo-info"></span></div>
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

  <h2 class="geo-h2">Цвета карты</h2>
  <div class="sub">Меняются в <code>css/styles.css</code>, блок «Карта топонимов» (переменные <code>--map-*</code>).</div>
  <table class="geo-tbl" style="width:auto"><tr><th>Образец</th><th>Переменная</th><th>Значение</th><th>Что красит</th></tr>
  {styles}</table>

  <h2 class="geo-h2">Задачи и топонимы</h2>
  <p class="legend geo-src-legend">Источник координат:
    <span class="src cache">кэш</span> <span class="src nominatim">Nominatim</span>
    <span class="src basemap">полигон страны</span> <span class="src llm">оценка модели</span> (не подтверждено геокодером).
    «км» — насколько найденная точка отстоит от оценки модели; красным — больше 50 км.
  </p>
  <div id="geo-table" class="geo-table"></div>
</section>
</div>
<script src="js/model.js"></script>
<script src="js/map/geo-model.js"></script>
<script src="js/map/geo-map.js"></script>
<script src="js/map/geo-table.js"></script>
<script>
  const cs = getComputedStyle(document.documentElement);
  document.querySelectorAll('.val').forEach(td => td.textContent = cs.getPropertyValue(td.dataset.var).trim());
  const geo = {geo_json};
  GanttMap.show(geo, GanttModel.parseDt({json.dumps(data.get("now") or "")}) || new Date());
  GanttGeoTable.mount(document.getElementById('geo-table'), geo.items);
</script>
</body></html>"""
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(page, encoding="utf-8")
    print(f"{OUT}  (задач {len(items)}, топонимов {n}: {stats})")


if __name__ == "__main__":
    main()
