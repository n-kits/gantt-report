"""
Локальная страница для проверки карты глазами: карта + таблица «задача → топонимы»
с источником координат и расхождением с оценкой модели + справочник цветов карты.

    python collect.py --dry-run -v        # обновить %LOCALAPPDATA%\\gantt-collector\\geo-review.json
    python geo_review.py                  # → in/geo-review.html (в .gitignore: там реальные задачи)
    python geo_review.py --compare-from in/live-real.json   # только in/geo-compare.html — варианты точек
Открыть через локальный сервер из корня репозитория: http://localhost:8765/in/geo-review.html
"""
import html
import json
import os
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent.parent
SRC = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "gantt-collector" / "geo-review.json"
OUT = REPO / "in" / "geo-review.html"
OUT_MAP = REPO / "in" / "geo-map.html"          # только карта; вид точек — ?points=dot|core|pie|ring
OUT_COMPARE = REPO / "in" / "geo-compare.html"  # четыре варианта точек рядом

VARIANTS = [
    ("core", "Две точки в одной (основной)", "Серый круг — все задачи за 3 дня; оранжевое ядро — задачи сегодня (его размер — по их числу)."),
    ("dot", "Круг (архив)", "Размер — все задачи за 3 дня; оранжевый, если место есть сегодня, иначе серый."),
    ("pie", "Сектора (архив)", "Размер — все задачи за 3 дня; сектора от 12 часов по часовой: "
                       "<b style=color:#C45C26>сегодня</b>, <b style=color:#8A919C>вчера</b>, <b style=color:#A9B0B9>позавчера</b>."),
    ("ring", "Кольцо (архив)", "Размер — все задачи за 3 дня; дуги по краю — доли дней (те же цвета, что у секторов); "
                       "центр оранжевый, если место есть сегодня."),
]

SRC_LABEL = {"cache": "кэш", "nominatim": "Nominatim", "llm": "оценка модели", "basemap": "полигон страны"}

STYLES = [
    ("--map-sea", "море и фон за картой"),
    ("--map-land", "суша"),
    ("--map-border", "границы стран и береговая линия"),
    ("--map-today", "оранжевое ядро (задачи сегодня) и его пульс"),
    ("--map-old", "серый круг точки (все задачи за три дня)"),
    ("--map-old-opacity", "его непрозрачность (0…1)"),
    ("--map-old2", "«позавчера» — только в архивных видах «сектора» и «кольцо»"),
    ("--map-halo", "белый ободок вокруг точек"),
    ("--map-hover", "кольцо вокруг точки под курсором"),
    ("--map-country-today", "заливка страны «сегодня»"),
    ("--map-country-today-line", "контур страны «сегодня» (под курсором — толще)"),
    ("--map-country-old", "заливка страны «вчера–позавчера»"),
    ("--map-country-old-line", "контур страны «вчера–позавчера» под курсором"),
]

e = html.escape


def load_live(path: str, password: str = "test") -> dict:
    """Зашифрованный снимок live.json (например, in/live-real.json с паролем test) → данные для карты."""
    import base64
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    env = json.loads(Path(path).read_text(encoding="utf-8"))
    enc, b = env["enc"], base64.b64decode
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b(enc["salt"]), iterations=enc["iter"]).derive(password.encode())
    p = json.loads(AESGCM(key).decrypt(b(enc["iv"]), b(enc["data"]), None))
    return {"now": p.get("now"), "items": p["geo"]["items"]}


def main():
    if "--compare-from" in sys.argv:
        # только страница сравнения вариантов точек — по сохранённому снимку
        snap = load_live(sys.argv[sys.argv.index("--compare-from") + 1])
        geo_json = json.dumps({"v": 1, "items": snap["items"]}, ensure_ascii=False).replace("</", r"<\/")
        write_compare(snap, geo_json)
        print(f"{OUT_COMPARE}  (снимок на {snap['now']}, задач {len(snap['items'])})")
        return
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
    <span class="gdot core"></span>серый круг — все задачи с этим топонимом за три дня, оранжевое ядро — из них сегодня (с 04:00).
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
    write_compare(data, geo_json)
    print(f"{OUT}  (задач {len(items)}, топонимов {n}: {stats})")
    print(f"{OUT_COMPARE}  (варианты точек)")


def write_compare(data, geo_json):
    now = json.dumps(data.get("now") or "")
    OUT_MAP.write_text(f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><base href="../"><title>Карта</title>
<link rel="stylesheet" href="css/styles.css">
<style>body {{ display:block; background:#fff; }} .geo {{ margin:0; }} .geo-stage {{ height: 100vh; border: 0; }}</style></head>
<body><section id="geo" class="geo" hidden>
  <div hidden><span id="geo-info"></span></div>
  <div id="geo-stage" class="geo-stage">
    <canvas id="geo-canvas"></canvas>
    <div class="geo-zoom">
      <button id="geo-zin" type="button" title="Приблизить">+</button>
      <button id="geo-zout" type="button" title="Отдалить">−</button>
      <button id="geo-fit" type="button" title="Показать все топонимы">⤢</button>
    </div>
    <div id="geo-tip" class="geo-tip" hidden></div>
  </div>
</section>
<script src="js/model.js"></script>
<script src="js/map/geo-model.js"></script>
<script src="js/map/geo-map.js"></script>
<script>GanttMap.show({geo_json}, GanttModel.parseDt({now}) || new Date());</script>
</body></html>""", encoding="utf-8")

    blocks = chr(10).join(f"""<section class="var">
  <h2>{i}. {title} <code>?points={key}</code></h2>
  <p class="legend">{desc} Пунктирный ободок — координаты по оценке модели.</p>
  <iframe src="in/geo-map.html?points={key}" loading="lazy"></iframe>
</section>""" for i, (key, title, desc) in enumerate(VARIANTS, 1))
    OUT_COMPARE.write_text(f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<base href="../"><title>Варианты точек</title>
<link rel="stylesheet" href="css/styles.css">
<style>
  body {{ display:block; }}
  .wrap {{ padding: 12px 16px 32px; }}
  h1 {{ margin: 0 0 4px; font-size: 22px; color: var(--header); }}
  .sub {{ color: var(--gray); font-size: 13px; }}
  .var h2 {{ margin: 22px 0 2px; font-size: 17px; color: var(--header); }}
  .var h2 code {{ font-size: 12px; color: var(--gray); font-weight: 400; }}
  .var .legend {{ margin: 0 0 6px; }}
  iframe {{ width: 100%; height: 540px; border: 1px solid var(--line); background: #fff; display: block; }}
</style></head>
<body><div class="wrap">
<h1>Варианты точек на карте</h1>
<div class="sub">Одни и те же реальные данные (Bitrix на {e(data.get("now") or "")}), «сегодня» — с 04:00.
Каждая карта масштабируется независимо. Любой вариант можно посмотреть и на основной странице: добавить к адресу
<code>?points=core</code>, <code>?points=pie</code> или <code>?points=ring</code>.</div>
{blocks}
</div></body></html>""", encoding="utf-8")


if __name__ == "__main__":
    main()
