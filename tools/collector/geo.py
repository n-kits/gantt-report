# -*- coding: utf-8 -*-
"""
Топонимы для карты под лентой: полные описания задач → Claude (тема, тональность,
топонимы с макрорегионом) → координаты (кэш → Nominatim → оценка модели).

Работает внутри collect.py; в LLM уходят только новые или изменённые задачи
(ключ — хеш «название + превью описания»), остальное берётся из geo-state.json.
Публикуется только раздел geo: ID, время регистрации, тема/тональность и топонимы
с координатами — без текстов описаний.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import time
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

log = logging.getLogger("collector")

HERE = Path(__file__).resolve().parent
BASEMAP_PATH = HERE.parent.parent / "data" / "basemap.json"

FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}
MAX_TEXT = 4000            # символов описания в LLM
BATCH_SIZE = 8             # задач в одном запросе
KEEP_DAYS = 7              # сколько помнить задачи, пропавшие из выборки
NOMINATIM_PAUSE = 1.1      # правило Nominatim: не чаще 1 запроса в секунду
USER_AGENT = "emg24_gantt_geo"
# насколько найденная точка может отстоять от оценки модели, км
TOLERANCE_KM = {"settlement": 150, "other": 300, "water": 1500, "region": 1000}

THEMES = [
    "Атмосферные явления", "Война", "Время", "Вулканы", "Выборы",
    "Гидрология", "Гипсометрия", "Гляциология", "Динамика Земли",
    "Животные", "Здравоохранение", "Землетрясения", "История", "Катастрофы", "Космос",
    "Майнинг", "Полезные ископаемые", "Метеостанции", "Маршруты",
    "Метро", "Мосты", "Олимпиада", "Осадки", "Пожары", "Политика",
    "Праздники", "Природоохранные территории", "Проекты планировки",
    "Растительность", "Религия и народы", "Рельеф", "Сельское хозяйство",
    "Солнечное затмение", "Социальные темы", "Спорные территории",
    "Спорт", "Тектоника", "Температуры", "Территориальные претензии",
    "Торговля", "Транспорт", "Трубопроводы",
    "Экология", "Энергетика", "Этнография", "Экономика",
]

SYSTEM_PROMPT = """Ты — аналитик картографической редакции новостного телеканала. Тебе передают заказы \
на карты: название задачи и текст заявки. Для каждого заказа определи:

1. ТЕМАТИКА — одна или две (если одна — подмножество другой) из списка:
{themes}

2. КОНФЛИКТ — если среди тематик есть «Война», конкретизируй конфликт: «Война в Украине», \
«Война в Сирии», «Война в Газе» и т.п. Иначе пустая строка.

3. ТОНАЛЬНОСТЬ — Позитивная, Негативная или Нейтральная.
Боевые действия, удары, налёты, атаки, освобождение и захват территорий, СВО — нейтральная.
Теракты, преступления, природные и техногенные катастрофы, негативные социальные и экономические \
события — негативная. Праздники, достижения, рекорды, позитивные социальные, экономические и \
спортивные события — позитивная. Остальное — нейтральная.

4. ТОПОНИМЫ — все географические объекты, которые будут на карте: страны, регионы, населённые \
пункты, реки, моря, острова, горы, улицы, объекты. Для каждого:
- name — в именительном падеже, как принято в русских СМИ;
- kind — country (государство), region (регион, область, штат, провинция, район), settlement \
(город, село, посёлок), water (море, река, озеро, залив, пролив, океан), other (остальное);
- macro — макрорегион из контекста для точного геокодирования: для населённых пунктов, улиц и \
объектов — область/край/провинция и страна («Донецкая область, Россия», «Курская область, Россия», \
«провинция Идлиб, Сирия»); для регионов и водоёмов — страна или часть света; для стран — пустая строка;
- query — строка для геокодера OpenStreetMap: название, район (если известен), регион, страна, \
через запятую, по-русски;
- country — код страны ISO 3166-1 alpha-3 (для стран — код самой страны; для морей и океанов — \
пустая строка);
- lat, lon — твоя оценка координат центра объекта в градусах.
ДНР и ЛНР — это Донецкая и Луганская области; Донецкая, Луганская, Запорожская, Херсонская области \
и Крым — Россия (код RUS).
Если одноимённых мест несколько, выбирай по контексту заказа. Не включай в топонимы названия \
студий, программ, каналов, графики, людей и организаций. Не выдумывай: если топонимов нет — \
пустой список.""".format(themes="\n".join(f"- {t}" for t in THEMES))

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "themes": {"type": "array", "items": {"type": "string", "enum": THEMES}},
                    "conflict": {"type": "string"},
                    "sentiment": {"type": "string", "enum": ["Позитивная", "Негативная", "Нейтральная"]},
                    "toponyms": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "kind": {"type": "string", "enum": ["country", "region", "settlement", "water", "other"]},
                                "macro": {"type": "string"},
                                "query": {"type": "string"},
                                "country": {"type": "string"},
                                "lat": {"type": "number"},
                                "lon": {"type": "number"},
                            },
                            "required": ["name", "kind", "macro", "query", "country", "lat", "lon"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["id", "themes", "conflict", "sentiment", "toponyms"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["items"],
    "additionalProperties": False,
}


# ---------------------------------------------------------------------------
# Ключ API: переменная окружения; процесс мог стартовать до её появления —
# тогда читаем из реестра (пользователь, затем система).
# ---------------------------------------------------------------------------

def api_key() -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    try:
        import winreg
    except ImportError:
        return None
    for hive, path in ((winreg.HKEY_CURRENT_USER, r"Environment"),
                       (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")):
        try:
            with winreg.OpenKey(hive, path) as k:
                return winreg.QueryValueEx(k, "ANTHROPIC_API_KEY")[0]
        except OSError:
            continue
    return None


# ---------------------------------------------------------------------------
# Полное описание со страницы задачи
# ---------------------------------------------------------------------------

class _Text(HTMLParser):
    BREAK = {"br", "p", "li", "div", "tr", "h1", "h2", "h3", "h4", "ul", "ol"}

    def __init__(self):
        super().__init__()
        self.out = []

    def handle_starttag(self, tag, attrs):
        if tag in self.BREAK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.BREAK:
            self.out.append("\n")

    def handle_data(self, data):
        self.out.append(data)


def html_to_text(html: str) -> str:
    p = _Text()
    p.feed(html)
    text = "".join(p.out).replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.split("\n")]
    return re.sub(r"\n{2,}", "\n", "\n".join(lines)).strip()


def _block(html: str, block_id: str) -> str | None:
    """Внутренность <div id="block_id"> до парного </div>."""
    m = re.search(rf'<div[^>]*\bid="{block_id}"[^>]*>', html)
    if not m:
        return None
    depth, pos = 1, m.end()
    for t in re.finditer(r"<(/?)div\b[^>]*>", html[pos:]):
        depth += -1 if t.group(1) else 1
        if depth == 0:
            return html[pos:pos + t.start()]
    return None


def extract_description(html: str) -> str:
    # «Описание задачи» (внутрисистемный текст), иначе исходное письмо заявки
    for bid in ("textDescriptionBlock", "textDescriptionBlockHtml"):
        inner = _block(html, bid)
        if inner:
            text = html_to_text(inner)
            if text:
                return text
    return ""


def is_truncated(preview: str) -> bool:
    return preview.rstrip().endswith(("...", "…"))


# ---------------------------------------------------------------------------
# Хранилища
# ---------------------------------------------------------------------------

def _load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _save_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", str(s or "").lower().replace("ё", "е")).strip()


class GeoCache:
    """
    Кэш геокодирования {название: [lat, lon] | null}, совместим с geocode_tasks.py.
    Найденное Nominatim хранится как [lat, lon, "nominatim"] — чтобы было видно, откуда точка.
    """

    def __init__(self, path: Path):
        self.path = path
        self.data: dict = _load_json(path, {})
        self.index = {norm(k): k for k in self.data}
        self.dirty = False

    def get(self, name: str):
        k = self.index.get(norm(name))
        return (k in self.data, self.data.get(k)) if k else (False, None)

    def put(self, name: str, coords) -> None:
        k = self.index.get(norm(name), name)
        self.data[k] = coords
        self.index[norm(k)] = k
        self.dirty = True

    def save(self) -> None:
        if self.dirty:
            _save_json(self.path, self.data)
            self.dirty = False

    def import_geojson(self, src: Path) -> int:
        fc = json.loads(Path(src).read_text(encoding="utf-8"))
        n = 0
        for f in fc.get("features", []):
            name = (f.get("properties") or {}).get("name")
            g = f.get("geometry") or {}
            if name and g.get("type") == "Point" and norm(name) not in self.index:
                lon, lat = g["coordinates"][:2]
                self.put(name, [round(lat, 5), round(lon, 5)])
                n += 1
        self.save()
        return n


def km(a, b) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(min(1, math.sqrt(h)))


# ---------------------------------------------------------------------------
# LLM
# ---------------------------------------------------------------------------

def analyze(tasks: list[dict], cfg: dict) -> dict:
    """tasks: [{id, name, text}] → {id: {themes, conflict, sentiment, toponyms}}."""
    import anthropic

    key = api_key()
    if not key:
        raise RuntimeError("не задан ANTHROPIC_API_KEY")
    client = anthropic.Anthropic(api_key=key, timeout=180, max_retries=2)
    out = {}
    for i in range(0, len(tasks), BATCH_SIZE):
        batch = tasks[i:i + BATCH_SIZE]
        body = "\n\n".join(f"--- Заказ ID: {t['id']} ---\nНазвание: {t['name']}\n{t['text'][:MAX_TEXT]}" for t in batch)
        model = cfg.get("llm_model", "claude-opus-5-5")
        # при отказе классификатора сервер сам повторит запрос на другой модели
        # (параметр есть не у всех моделей)
        fb = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"} if model in FALLBACK_MODELS else {}
        resp = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            **fb,
            output_config={"effort": cfg.get("llm_effort", "medium"),
                           "format": {"type": "json_schema", "schema": SCHEMA}},
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": body}],
        )
        if resp.stop_reason == "refusal":
            cat = resp.stop_details.category if resp.stop_details else None
            log.warning("Модель отказалась анализировать задачи %s (%s)", [t["id"] for t in batch], cat)
            continue
        if resp.stop_reason == "max_tokens":
            log.warning("Ответ модели обрезан (max_tokens) для задач %s", [t["id"] for t in batch])
            continue
        text = next((b.text for b in resp.content if b.type == "text"), "")
        for item in json.loads(text).get("items", []):
            out[str(item["id"])] = {k: item[k] for k in ("themes", "conflict", "sentiment", "toponyms")}
        log.info("LLM: задач %s, токенов вход/выход %s/%s", len(batch), resp.usage.input_tokens, resp.usage.output_tokens)
    return out


# ---------------------------------------------------------------------------
# Геокодирование
# ---------------------------------------------------------------------------

class Geocoder:
    def __init__(self, cache: GeoCache):
        self.cache = cache
        self._nom = None
        self._last = 0.0
        self.countries = {c["iso"] for c in _load_json(BASEMAP_PATH, {}).get("countries", [])}
        self.unresolved: list[str] = []

    def _nominatim(self, query: str):
        """→ (кандидаты [[lat, lon], …], был ли ответ). Одноимённых мест бывает несколько."""
        if self._nom is None:
            from geopy.geocoders import Nominatim
            self._nom = Nominatim(user_agent=USER_AGENT, timeout=10)
        wait = NOMINATIM_PAUSE - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        try:
            locs = self._nom.geocode(query, language="ru", exactly_one=False, limit=5) or []
        except Exception as e:  # noqa: BLE001 — сеть/лимиты: просто нет ответа
            log.warning("Nominatim «%s»: %s", query, e)
            return [], False
        finally:
            self._last = time.time()
        return [[round(x.latitude, 5), round(x.longitude, 5)] for x in locs], True

    def resolve(self, t: dict) -> dict | None:
        """Топоним из LLM → запись для карты или None."""
        name = (t.get("name") or "").strip()
        if not name:
            return None
        kind = t.get("kind") or "other"
        iso = (t.get("country") or "").upper()
        if kind == "country" and iso in self.countries:
            return {"name": name, "kind": "country", "iso": iso, "_src": "basemap"}

        est = [t["lat"], t["lon"]] if isinstance(t.get("lat"), (int, float)) and isinstance(t.get("lon"), (int, float)) else None
        tol = TOLERANCE_KM.get(kind, 500)
        ok = lambda c: c and (est is None or km(c, est) <= tol)
        macro = (t.get("macro") or "").split(",")[0].strip()
        keys = [f"{name} ({macro})", name] if macro else [name]

        for k in keys:                                   # 1. кэш
            found, c = self.cache.get(k)
            if found and c and ok(c[:2]):
                return self._point(name, kind, c[:2], c[2] if len(c) > 2 else "cache")
        query = (t.get("query") or "").strip()
        asked = False
        if query:                                        # 2. Nominatim (ответ, даже пустой, кэшируется)
            found, cands = self.cache.get(f"@{query}")
            if not found:
                cands, asked = self._nominatim(query)
                if asked:
                    self.cache.put(f"@{query}", cands)
            cands = [cands] if cands and isinstance(cands[0], (int, float)) else (cands or [])
            if est and cands:                            # из одноимённых — ближайший к оценке модели
                cands = sorted(cands, key=lambda c: km(c, est))
            c = cands[0] if cands else None
            if ok(c):
                self.cache.put(keys[0], c + ["nominatim"])
                return self._point(name, kind, c, "nominatim")
        # 3. оценка модели; в журнал — только впервые (когда спрашивали Nominatim в этот раз)
        if asked or not query:
            self.unresolved.append(f"{name}; {macro}; {query}; {est[0] if est else ''}; {est[1] if est else ''}")
        return self._point(name, kind, est, "llm", approx=True) if est else None

    @staticmethod
    def _point(name, kind, c, src, approx=False):
        p = {"name": name, "kind": kind, "lat": c[0], "lon": c[1], "_src": src}
        if approx:
            p["approx"] = True
        return p


# ---------------------------------------------------------------------------
# Этап сборщика
# ---------------------------------------------------------------------------

def task_hash(name: str, preview: str) -> str:
    return hashlib.sha1(f"{name}\n{preview}".encode("utf-8")).hexdigest()[:16]


def pending(state: dict, res: dict) -> list[dict]:
    """Задачи, которые надо (пере)анализировать: новые или с изменённым названием/описанием."""
    out = []
    for row, t in zip(res["rows"], res.get("tasks", [])):
        h = task_hash(row[0], t["description"])
        st = state["tasks"].get(t["id"])
        if not st or st.get("hash") != h or "result" not in st:
            out.append({"id": t["id"], "name": row[0], "url": t["url"], "preview": t["description"], "hash": h})
    return out


def fetch_texts(ctx, base_url: str, todo: list[dict], limit: int) -> None:
    """
    Полный текст со страницы задачи (запрос с куками профиля, без отрисовки) —
    если превью нет (колонка «Описание» не включена) или оно обрезано.
    Без поля text задача не анализируется и будет повторена в следующий запуск.
    """
    for t in todo[:limit]:
        if not t["url"] or (t["preview"] and not is_truncated(t["preview"])):
            t["text"] = t["preview"]
            continue
        try:
            r = ctx.request.get(urljoin(base_url, t["url"]), timeout=60_000)
        except Exception as e:  # noqa: BLE001 — сеть: повторим в следующий раз
            log.warning("Задача %s: не удалось открыть страницу: %s", t["id"], e)
            continue
        if not r.ok:
            log.warning("Задача %s: HTTP %s", t["id"], r.status)
            continue
        # в страницах Bitrix встречаются байты не из UTF-8 — заменяем, а не падаем
        full = extract_description(r.body().decode("utf-8", "replace"))
        if not full:
            log.info("Задача %s: описания на странице нет — анализ по названию", t["id"])
        t["text"] = full or t["preview"]


def build(app_dir: Path, cfg: dict, res: dict, todo: list[dict]) -> dict:
    """Анализ новых задач, геокодирование, раздел geo для payload."""
    state_path = app_dir / "geo-state.json"
    state = _load_json(state_path, {"tasks": {}})
    todo = [t for t in todo if "text" in t]
    if todo:
        try:
            results = analyze([{"id": t["id"], "name": t["name"], "text": t["text"]} for t in todo], cfg)
        except Exception as e:  # noqa: BLE001 — лента публикуется и без карты
            log.error("Анализ топонимов не удался: %s: %s", type(e).__name__, e)
            results = {}
        now = datetime.now().isoformat(timespec="seconds")
        for t in todo:
            if t["id"] in results:
                state["tasks"][t["id"]] = {"hash": t["hash"], "result": results[t["id"]], "analyzedAt": now}

    cache = GeoCache(app_dir / "geocache.json")
    coder = Geocoder(cache)
    items, review = [], []
    today = datetime.now().date().isoformat()
    for row, t in zip(res["rows"], res.get("tasks", [])):
        st = state["tasks"].get(t["id"])
        if not st:
            continue
        st["seen"] = today
        r = st.get("result") or {}
        pairs = [(x, coder.resolve(x)) for x in r.get("toponyms", [])]
        tops = [{k: v for k, v in p.items() if not k.startswith("_")} for _, p in pairs if p]
        items.append({"id": t["id"], "start": row[2], "themes": r.get("themes", []),
                      "conflict": r.get("conflict", ""), "sentiment": r.get("sentiment", ""), "toponyms": tops})
        # локальный разбор для проверки глазами (geo-review.json, не публикуется)
        review.append({"id": t["id"], "name": row[0], "start": row[2], "project": row[6], "product": row[7],
                       "themes": r.get("themes", []), "conflict": r.get("conflict", ""), "sentiment": r.get("sentiment", ""),
                       "toponyms": [dict(llm=x, got=p) for x, p in pairs]})
    cache.save()
    _save_json(app_dir / "geo-review.json", {"now": res.get("now"), "model": cfg.get("llm_model"), "items": review})

    cutoff = (datetime.now() - timedelta(days=KEEP_DAYS)).date().isoformat()
    state["tasks"] = {k: v for k, v in state["tasks"].items() if v.get("seen", today) >= cutoff}
    _save_json(state_path, state)
    if coder.unresolved:
        with open(app_dir / "geo-unresolved.log", "a", encoding="utf-8") as f:
            for line in sorted(set(coder.unresolved)):
                f.write(f"{today}; {line}\n")
    n = sum(len(i["toponyms"]) for i in items)
    approx = sum(1 for i in items for p in i["toponyms"] if p.get("approx"))
    log.info("Карта: задач с анализом %s из %s, топонимов %s, приблизительных %s",
             len(items), len(res["rows"]), n, approx)
    return {"v": 1, "items": items}
