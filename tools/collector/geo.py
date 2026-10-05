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

from scrub import clean

log = logging.getLogger("collector")

HERE = Path(__file__).resolve().parent
BASEMAP_PATH = HERE.parent.parent / "data" / "basemap.json"

FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}
MAX_TEXT = 4000
MAX_ATTEMPTS = 3          # попыток анализа одной задачи            # символов описания в LLM
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
- region — для мест в России и на Украине: субъект РФ или область Украины, где находится объект, \
строго одно значение из списка; для остальных стран, морей, рек и самих стран — пустая строка \
(регион за пределами России и Украины укажи в query);
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
                                "region": {"type": "string"},   # закрытый список — см. schema()
                                "query": {"type": "string"},
                                "country": {"type": "string"},
                                "lat": {"type": "number"},
                                "lon": {"type": "number"},
                            },
                            "required": ["name", "kind", "region", "query", "country", "lat", "lon"],
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


_SCHEMA = None


REGION_LIST_RULE = "строго одно значение из списка"
REGION_FREE_RULE = "официальное название субъекта или области"


def system_prompt(region_list: bool = True) -> str:
    """Без закрытого списка регион — свободный текст (так было до 10.2026)."""
    return SYSTEM_PROMPT if region_list else SYSTEM_PROMPT.replace(REGION_LIST_RULE, REGION_FREE_RULE)


def schema(region_list: bool = True) -> dict:
    """SCHEMA с закрытым списком регионов (субъекты РФ и области Украины из справочника границ):
    одинаковые формулировки во всех заказах — и подсказка геокодеру, и единый регион.
    region_list=False — регион свободной строкой (дешевле на ~8 тыс. входных токенов на запрос)."""
    global _SCHEMA
    if not region_list:
        return SCHEMA
    if _SCHEMA is None:
        import copy
        import places
        _SCHEMA = copy.deepcopy(SCHEMA)
        top = _SCHEMA["properties"]["items"]["items"]["properties"]["toponyms"]["items"]["properties"]
        top["region"] = {"type": "string", "enum": [""] + places.region_enum()}
    return _SCHEMA


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

def analyze(tasks: list[dict], cfg: dict, region_list: bool | None = None, cache_ttl: str | None = None,
            usage: list | None = None) -> dict:
    """
    tasks: [{id, name, text}] → {id: {themes, conflict, sentiment, toponyms}}.
    region_list — закрытый список регионов (по умолчанию cfg["llm_region_list"], иначе да);
    cache_ttl — кэширование промпта «5m» / «1h» (по умолчанию cfg["llm_cache_ttl"], иначе без кэша):
    системная инструкция одинакова во всех запросах, метка кэша — на её конце;
    usage — сюда дописывается расход токенов по каждому запросу.
    """
    import anthropic

    key = api_key()
    if not key:
        raise RuntimeError("не задан ANTHROPIC_API_KEY")
    client = anthropic.Anthropic(api_key=key, timeout=180, max_retries=2)
    if region_list is None:
        region_list = cfg.get("llm_region_list", True)
    if cache_ttl is None:
        cache_ttl = cfg.get("llm_cache_ttl")
    system = system_prompt(region_list)
    if cache_ttl:
        cc = {"type": "ephemeral"} if cache_ttl == "5m" else {"type": "ephemeral", "ttl": cache_ttl}
        system = [{"type": "text", "text": system, "cache_control": cc}]
    out = {}
    for i in range(0, len(tasks), BATCH_SIZE):
        batch = tasks[i:i + BATCH_SIZE]
        body = "\n\n".join(f"--- Заказ ID: {t['id']} ---\nНазвание: {t['name']}\n{t['text'][:MAX_TEXT]}" for t in batch)
        model = cfg.get("llm_model", "claude-sonnet-5-5")
        # при отказе классификатора сервер сам повторит запрос на другой модели
        # (параметр есть не у всех моделей)
        fb = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"} if model in FALLBACK_MODELS else {}
        resp = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            **fb,
            output_config={"effort": cfg.get("llm_effort", "medium"),
                           "format": {"type": "json_schema", "schema": schema(region_list)}},
            system=system,
            messages=[{"role": "user", "content": body}],
        )
        u = resp.usage
        rec = {"tasks": len(batch), "input": u.input_tokens, "output": u.output_tokens,
               "cache_write": getattr(u, "cache_creation_input_tokens", 0) or 0,
               "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0, "stop": resp.stop_reason}
        if usage is not None:
            usage.append(rec)
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
        log.info("LLM: задач %s, токенов вход/выход %s/%s, кэш запись/чтение %s/%s", len(batch),
                 rec["input"], rec["output"], rec["cache_write"], rec["cache_read"])
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
        # подсказка геокодеру: регион из закрытого списка (старые ответы — первая часть macro)
        macro = (t.get("region") or (t.get("macro") or "").split(",")[0]).strip()
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
        if st and st.get("hash") == h and ("result" in st or not retry_due(st)):
            continue
        item = {"id": t["id"], "name": row[0], "url": t["url"], "preview": t["description"], "hash": h}
        if st and st.get("hash") == h and st.get("text"):
            item["text"] = st["text"]       # текст уже скачан (анализ был выключен или не удался)
        out.append(item)
    return out


def retry_due(st: dict) -> bool:
    """Неудачный анализ (отказ модели, сбой API) повторяем через 1, 2 ч и бросаем после 3 попыток."""
    n = st.get("attempts", 0)
    if n >= MAX_ATTEMPTS:
        return False
    try:
        return datetime.now() >= datetime.fromisoformat(st["failedAt"]) + timedelta(hours=n)
    except (KeyError, ValueError):
        return True


def fetch_texts(ctx, base_url: str, todo: list[dict], limit: int) -> None:
    """
    Полный текст со страницы задачи (запрос с куками профиля, без отрисовки) —
    если превью нет (колонка «Описание» не включена) или оно обрезано.
    Без поля text задача не анализируется и будет повторена в следующий запуск.
    Текст сразу очищается от личных данных (scrub.py): дальше — в очередь, архив и LLM — идёт только очищенный.
    """
    for t in [x for x in todo if "text" not in x][:limit]:
        if not t["url"] or (t["preview"] and not is_truncated(t["preview"])):
            t["text"] = clean(t["preview"])
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
        t["text"] = clean(full or t["preview"])


def published(llm: dict, got: dict | None) -> dict | None:
    """
    Топоним для live.json: координаты или код страны, тип, регион и страна по координатам, идентификатор
    места (pid), регион по версии LLM (macro), источник координат (cache / nominatim / llm / basemap)
    и расхождение с оценкой модели, км.
    """
    if not got:
        return None
    import places
    p = {k: v for k, v in got.items() if not k.startswith("_")}
    p["macro"] = llm.get("region") or llm.get("macro", "")       # как назвала LLM — для сверки
    # регион, страна и идентификатор места — по координатам (places.py), а не по тексту LLM
    c = places.canon(dict(p, iso=p.get("iso") or llm.get("country")))
    p.update(region=c["region"], country=c["country"], pid=c["pid"])
    p["src"] = got.get("_src", "")
    if "lat" in got and p["src"] not in ("llm", "basemap") and isinstance(llm.get("lat"), (int, float)):
        p["dkm"] = round(km([llm["lat"], llm["lon"]], [got["lat"], got["lon"]]))
    return p


def build(app_dir: Path, cfg: dict, res: dict, todo: list[dict]) -> dict:
    """Анализ новых задач, геокодирование, раздел geo для payload."""
    state_path = app_dir / "geo-state.json"
    state = _load_json(state_path, {"tasks": {}})
    todo = [t for t in todo if "text" in t]
    llm_on = cfg.get("llm", False)
    if todo and not llm_on:
        # «стоп»: в LLM ничего не уходит; тексты сохраняем, чтобы не скачивать заново
        for t in todo:
            prev = state["tasks"].get(t["id"]) or {}
            keep = {k: prev[k] for k in ("attempts", "failedAt") if prev.get("hash") == t["hash"] and k in prev}
            state["tasks"][t["id"]] = dict(keep, hash=t["hash"], text=t["text"],
                                           seen=prev.get("seen") or datetime.now().date().isoformat())
        log.info("LLM выключен (--llm on — включить): ждут анализа %s", len(todo))
    elif todo:
        try:
            results = analyze([{"id": t["id"], "name": t["name"], "text": t["text"]} for t in todo], cfg)
        except Exception as e:  # noqa: BLE001 — лента публикуется и без карты
            log.error("Анализ топонимов не удался: %s: %s", type(e).__name__, e)
            results = {}
        now = datetime.now().isoformat(timespec="seconds")
        for t in todo:
            if t["id"] in results:
                state["tasks"][t["id"]] = {"hash": t["hash"], "result": results[t["id"]], "analyzedAt": now,
                                           "model": cfg.get("llm_model")}
            else:
                prev = state["tasks"].get(t["id"]) or {}
                n = prev.get("attempts", 0) + 1 if prev.get("hash") == t["hash"] else 1
                state["tasks"][t["id"]] = {"hash": t["hash"], "failedAt": now, "attempts": n, "text": t["text"],
                                           "seen": prev.get("seen") or datetime.now().date().isoformat()}
                if n >= MAX_ATTEMPTS:
                    log.warning("Задача %s: анализ не удался %s раз — больше не пробуем", t["id"], n)

    cache = GeoCache(app_dir / "geocache.json")
    coder = Geocoder(cache)
    items = []
    waiting = 0                         # задачи окна без анализа, которые ещё будут разобраны
    today = datetime.now().date().isoformat()
    for row, t in zip(res["rows"], res.get("tasks", [])):
        st = state["tasks"].get(t["id"])
        if not st or "result" not in st:
            if not st or st.get("attempts", 0) < MAX_ATTEMPTS:
                waiting += 1
        if not st:
            continue
        st["seen"] = today
        if "result" not in st:          # анализа нет (выключен, не удался) — в карту и таблицу не попадает
            continue
        r = st.get("result") or {}
        tops = [p for p in (published(x, coder.resolve(x)) for x in r.get("toponyms", [])) if p]
        items.append({"id": t["id"], "start": row[2], "themes": r.get("themes", []),
                      "conflict": r.get("conflict", ""), "sentiment": r.get("sentiment", ""),
                      "model": st.get("model") or "", "toponyms": tops})
    cache.save()
    # для локальной страницы проверки (geo_review.py) — те же данные плюс поля задачи
    rows_by_id = {t["id"]: row for row, t in zip(res["rows"], res.get("tasks", []))}
    _save_json(app_dir / "geo-review.json", {"now": res.get("now"), "model": cfg.get("llm_model"), "items": [
        dict(it, name=rows_by_id[it["id"]][0], project=rows_by_id[it["id"]][6], product=rows_by_id[it["id"]][7])
        for it in items]})

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
    return {"v": 1, "llm": bool(llm_on), "waiting": waiting, "items": items}
