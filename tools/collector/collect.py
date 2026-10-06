#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Сборщик «живой» ленты: забирает список задач из Bitrix, шифрует и публикует
в ветку `data` репозитория — страница на GitHub Pages читает его оттуда.

    python collect.py --setup          # один раз: пароль для коллег и настройки
    python collect.py --login          # один раз / при разлогине: войти в Bitrix в окне Edge
    python collect.py                  # сбор + публикация (это и запускает Планировщик)
    python collect.py --dry-run        # сбор без публикации, результат в last-payload.json
    python collect.py --install-task   # зарегистрировать задачу в Планировщике Windows
    python collect.py --remove-task    # удалить задачу
    python collect.py --import-geocache in/analyze_geocode/geocache.geojson   # заполнить кэш координат
    python collect.py --export-day 2026-09-27   # выгрузить день из локального архива в Excel вручную
    python collect.py --llm off|on|status       # «стоп» для LLM: лента строится, новые задачи не анализируются
    python collect.py --backfill 2026-01-01 [2026-09-30]   # догрузить дни из Bitrix в архив (календарик на сайте)

Всё локальное (настройки, профиль Edge, журнал) — в %LOCALAPPDATA%\\gantt-collector.
Зависимости: playwright, cryptography; браузер — установленный Microsoft Edge.
Карта топонимов (geo.py): anthropic, geopy; ключ — переменная окружения ANTHROPIC_API_KEY.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import logging
import os
import subprocess
import sys
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
PARSER_JS = REPO_ROOT / "js" / "sources" / "bitrix-tasks.js"

APP_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "gantt-collector"
CONFIG_PATH = APP_DIR / "config.json"
PROFILE_DIR = APP_DIR / "edge-profile"
DATA_REPO = APP_DIR / "data-repo"
LAST_OK_PATH = APP_DIR / "last-ok.json"
LOCK_PATH = APP_DIR / "collect.lock"
SCHEDULE_PATH = APP_DIR / "schedule.json"   # когда был последний запуск по расписанию
LOG_PATH = APP_DIR / "collector.log"
TASK_NAME = "GanttCollector"

DEFAULTS = {
    "tasks_url": "https://crm.emg24.ru/company/personal/user/609/tasks/?F_FILTER_SWITCH_PRESET=2460",
    "source_name": "Bitrix · ВСЕ КАРТЫ Р24",
    "days": 3,                  # диапазон: последние N суток по времени регистрации
    "day_start_hour": 4,        # сутки начинаются в 04:00, как ось ленты
    "utc_offset_hours": 3,      # время пользователя Bitrix (МСК)
    "interval_min": 30,         # период запуска в Планировщике
    "align_minute": 15,         # запуски с выравниванием: :15, :45 (None — от момента установки)
    # частота по времени суток: [{"from": "07:00", "to": "23:00", "every_min": 15}, …]; Планировщик запускает
    # раз в interval_min, сборщик сам пропускает запуски, если по расписанию рано; None — всегда
    "schedule": None,
    "git_remote": "https://github.com/n-kits/gantt-report.git",
    "data_branch": "data",
    "data_file": "live.json",
    "kdf_iterations": 250000,
    "password": None,           # пароль шифрования для коллег (задаётся --setup)
    "geo": True,                # карта топонимов: анализ описаний через Claude + геокодирование
    "llm": False,               # анализ через Claude выключен по умолчанию; включить — --llm on / llm-on.cmd
    "llm_model": "claude-sonnet-5-5",
    "llm_effort": "medium",
    "llm_region_list": False,   # регион в ответе LLM — свободная строка (A/B 10.2026: качество как со списком, запрос вдвое дешевле)
    "llm_cache_ttl": None,      # кэш промпта: None — нет (запросы раз в 15+ мин по 1 заказу), «5m» / «1h»
    "geo_fetch_limit": 60,      # не больше стольких страниц задач за запуск
    "archive": True,            # локальный архив задач (archive.sqlite) и выгрузка выпавших дней в Excel
    "archive_dir": None,        # куда класть ГГГГ-ММ-ДД.xlsx; None — Документы\Лента времени — архив
    "publish_days": True,       # архив по дням в ветку data (days/ГГГГ-ММ-ДД.json, зашифровано) — календарик на сайте
    "publish_analytics": True,  # вкладка «Аналитика»: весь архив одним файлом (analytics.json, gzip + шифрование)
    "refresh_days": 14,         # раз в сутки перечитывать столько закрытых дней: на сайте и в Excel — текущие статусы
    "history_url": None,        # пресет Bitrix для --backfill и обновления, без ограничения по давности; None — tasks_url
    "chunk_days": 3,            # --backfill и обновление ходят в Bitrix кусками по столько суток
    "chunk_pause_sec": 3,       # пауза между кусками
}

log = logging.getLogger("collector")


class CollectError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Настройки, журнал, блокировка
# ---------------------------------------------------------------------------

def setup_logging(verbose: bool) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = RotatingFileHandler(LOG_PATH, maxBytes=512_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    if sys.stdout and sys.stdout.isatty() or verbose:
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        log.addHandler(sh)
    log.setLevel(logging.INFO)


def load_config() -> dict:
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
    return cfg


def save_config(cfg: dict) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


class Lock:
    """Не даём двум запускам (Планировщик + ручной) работать одновременно.
    Блокировка старше 15 минут считается брошенной — долгие запуски (--backfill) её обновляют."""

    def touch(self):
        LOCK_PATH.write_text(str(os.getpid()))

    def __enter__(self):
        APP_DIR.mkdir(parents=True, exist_ok=True)
        if LOCK_PATH.exists() and time.time() - LOCK_PATH.stat().st_mtime < 15 * 60:
            raise CollectError("BUSY", "Предыдущий запуск ещё идёт")
        LOCK_PATH.write_text(str(os.getpid()))
        return self

    def __exit__(self, *exc):
        LOCK_PATH.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Диапазон и адрес
# ---------------------------------------------------------------------------

def bitrix_now(cfg: dict) -> datetime:
    tz = timezone(timedelta(hours=cfg["utc_offset_hours"]))
    return datetime.now(tz).replace(tzinfo=None, microsecond=0)


def date_range(cfg: dict, now: datetime) -> tuple[datetime, datetime]:
    """Последние N суток: с 04:00 (N-1) дней назад до текущего момента."""
    start = now.replace(hour=cfg["day_start_hour"], minute=0, second=0)
    if start > now:
        start -= timedelta(days=1)
    return start - timedelta(days=cfg["days"] - 1), now


def fmt_bx(dt: datetime) -> str:
    return dt.strftime("%d.%m.%Y %H:%M")


def range_url(cfg: dict, frm: datetime, to: datetime, base: str | None = None) -> str:
    params = {
        "FILTER_DATE_AFTER_RANGE": fmt_bx(frm),
        "FILTER_DATE_BEFORE_RANGE": fmt_bx(to),
        "FILTER_DATE_PRESET_RANGE": "random_interval",
        "FILTER_DATE_OPTION_VALUE_RANGE": "created_date",
        "SHOWALL_1": "1",
    }
    base = base or cfg["tasks_url"]
    sep = "&" if "?" in base else "?"
    return base + sep + "&".join(f"{k}={quote(v)}" for k, v in params.items())


# ---------------------------------------------------------------------------
# Браузер
# ---------------------------------------------------------------------------

EVAL_PARSE = """() => {
  try { return { ok: true, ...GanttBitrix.parseBitrixTasks(document) }; }
  catch (e) { return { ok: false, code: e.code || 'PARSE_ERROR', message: String(e.message || e) }; }
}"""

EVAL_RANGE = """() => {
  const v = n => { const el = document.querySelector(`#globalDateFilterFormRange input[name="${n}"]`); return el ? el.value : null; };
  return { after: v('FILTER_DATE_AFTER_RANGE'), before: v('FILTER_DATE_BEFORE_RANGE') };
}"""

EVAL_SUBMIT_RANGE = """([after, before]) => {
  const f = document.getElementById('globalDateFilterFormRange');
  if (!f) return false;
  const set = (n, v) => { const el = f.querySelector(`input[name="${n}"]`); if (el) el.value = v; };
  set('FILTER_DATE_AFTER_RANGE', after);
  set('FILTER_DATE_BEFORE_RANGE', before);
  set('FILTER_DATE_PRESET_RANGE', 'random_interval');
  set('FILTER_DATE_OPTION_VALUE_RANGE', 'created_date');
  f.submit();
  return true;
}"""


def open_context(pw, headless: bool):
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    return pw.chromium.launch_persistent_context(
        str(PROFILE_DIR), channel="msedge", headless=headless,
        locale="ru-RU", viewport={"width": 1600, "height": 1000},
    )


def parse_page(page) -> dict:
    page.add_script_tag(content=PARSER_JS.read_text(encoding="utf-8"))
    res = page.evaluate(EVAL_PARSE)
    if not res["ok"]:
        raise CollectError(res["code"], res["message"])
    return res


def open_range(page, cfg: dict, frm: datetime, to: datetime, base: str | None = None) -> dict:
    """Список задач Bitrix с фильтром «дата создания» от frm до to → результат разбора."""
    url = range_url(cfg, frm, to, base)
    log.info("Открываю %s", url)
    page.goto(url, wait_until="domcontentloaded", timeout=90_000)
    page.wait_for_load_state("networkidle", timeout=60_000)

    # Если сервер не принял диапазон из адреса — отправляем форму, как человек
    got = page.evaluate(EVAL_RANGE)
    if got["after"] and got["after"] != fmt_bx(frm):
        log.info("Диапазон из адреса не применился (%s) — отправляю форму", got)
        with page.expect_navigation(timeout=90_000):
            page.evaluate(EVAL_SUBMIT_RANGE, [fmt_bx(frm), fmt_bx(to)])
        page.wait_for_load_state("networkidle", timeout=60_000)
        got = page.evaluate(EVAL_RANGE)

    res = parse_page(page)
    if got["after"] and got["after"] != fmt_bx(frm):
        raise CollectError("RANGE_NOT_APPLIED", f"Не удалось выставить диапазон: на странице {got}")
    if res.get("hasNextPage"):
        raise CollectError("PAGINATED", "Список разбит на страницы — включите «показать все» в Bitrix")
    res["range"] = {"from": fmt_bx(frm), "to": fmt_bx(to)}
    log.info("Задач: %s, диапазон %s — %s, время Bitrix %s", res["count"], *res["range"].values(), res["now"])
    return res


def fetch_tasks(cfg: dict, geo_state: dict | None = None) -> dict:
    from playwright.sync_api import sync_playwright

    now = bitrix_now(cfg)
    frm, to = date_range(cfg, now)
    with sync_playwright() as pw:
        ctx = open_context(pw, headless=True)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            res = open_range(page, cfg, frm, to)
            if geo_state is not None:
                # полные описания новых задач — пока открыт браузер с сессией Bitrix
                import geo
                res["geo_todo"] = geo.pending(geo_state, res)
                geo.fetch_texts(ctx, page.url, res["geo_todo"], cfg["geo_fetch_limit"])
                if res["geo_todo"]:
                    log.info("Карта: новых/изменённых задач %s", len(res["geo_todo"]))
            return res
        finally:
            ctx.close()


def day_chunks(cfg: dict, d_from: date, d_to: date, now: datetime) -> list[tuple[datetime, datetime, list[str]]]:
    """Рабочие дни d_from…d_to (сутки с 04:00) → куски по chunk_days: (от, до, [дни куска])."""
    h, size = cfg["day_start_hour"], max(1, int(cfg["chunk_days"]))
    out, d = [], d_from
    while d <= d_to:
        e = min(d + timedelta(days=size), d_to + timedelta(days=1))
        frm = datetime.combine(d, dtime(h))
        if frm >= now:
            break
        to = min(datetime.combine(e, dtime(h)), now)
        out.append((frm, to, [(d + timedelta(days=i)).isoformat() for i in range((e - d).days)]))
        d = e
    return out


def sync_days(cfg: dict, db, d_from: date, d_to: date, lock: "Lock | None" = None) -> list[str]:
    """Перечитать из Bitrix рабочие дни d_from…d_to кусками (history_url): текущие статусы в архив.
    Задачи, которых Bitrix за прошлые дни не вернул, НЕ удаляются: пресет может не показывать
    старые задачи (у «ВСЕ КАРТЫ Р24» горизонт ~5 суток) — неполная выдача не должна стирать архив.
    Возвращает дни, за которые Bitrix вернул хоть одну задачу."""
    import archive
    from playwright.sync_api import sync_playwright

    chunks = day_chunks(cfg, d_from, d_to, bitrix_now(cfg))
    done: list[str] = []
    with sync_playwright() as pw:
        ctx = open_context(pw, headless=True)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            for k, (frm, to, days) in enumerate(chunks):
                if k:
                    time.sleep(cfg["chunk_pause_sec"])     # не нагружаем Bitrix
                res = open_range(page, cfg, frm, to, cfg.get("history_url"))
                archive.update(db, cfg, res, None, {})
                seen = {t["id"] for t in res.get("tasks", [])}
                missing = archive.missing(db, days, seen)
                if missing:
                    log.warning("Архив: за %s Bitrix не вернул %s задач из архива — оставлены как есть: %s",
                                ", ".join(days), len(missing), ", ".join(missing))
                done += sorted({archive.workday(r[2], cfg["day_start_hour"]) for r in res["rows"]} & set(days))
                if lock:
                    lock.touch()
        finally:
            ctx.close()
    return done


def interactive_login(cfg: dict) -> None:
    from playwright.sync_api import sync_playwright

    print("Откроется окно Edge. Войдите в Bitrix (отметьте «Запомнить меня»), дождитесь списка задач.")
    with sync_playwright() as pw:
        ctx = open_context(pw, headless=False)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(cfg["tasks_url"], wait_until="domcontentloaded", timeout=120_000)
        try:
            page.wait_for_selector("table#task-list-table", timeout=10 * 60_000)
            print("Вход выполнен, список задач виден. Окно можно закрыть — сессия сохранена.")
            page.wait_for_timeout(1500)
        finally:
            ctx.close()


# ---------------------------------------------------------------------------
# Шифрование (совместимо с WebCrypto: AES-GCM, ключ PBKDF2-SHA256)
# ---------------------------------------------------------------------------

def b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def kdf_salt(password: str, iterations: int) -> bytes:
    """Одна соль PBKDF2 на все файлы (live.json, days/, analytics.json): браузер вычисляет ключ один раз,
    а не на каждый файл (250 000 итераций — заметные доли секунды). Уникальность шифрования даёт случайный iv
    каждого файла. Соль хранится на этом ПК — своя на каждую пару «пароль + число итераций» (по отпечатку, не по
    паролю): самопроверка с тестовым паролем не сбивает соль настоящего и не вызывает перешифровку архива."""
    path = APP_DIR / "kdf-salt.json"
    tag = hashlib.sha256(f"{password}\0{iterations}".encode("utf-8")).hexdigest()
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    salts = saved.get("salts") or ({saved["tag"]: saved["salt"]} if saved.get("tag") else {})   # прежний формат: одна соль
    if tag in salts:
        return base64.b64decode(salts[tag])
    salt = os.urandom(16)
    salts[tag] = b64(salt)
    path.write_text(json.dumps({"salts": salts}), encoding="utf-8")
    return salt


_keys: dict[tuple, bytes] = {}


def encrypt(payload: dict, password: str, iterations: int, compress: bool = False) -> dict:
    """compress — gzip до шифрования (зашифрованное уже не сожмётся при передаче); в конверте "zip": "gzip"."""
    import gzip
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    salt, iv = kdf_salt(password, iterations), os.urandom(12)
    k = (password, iterations, salt)
    if k not in _keys:
        _keys[k] = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations).derive(password.encode("utf-8"))
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":") if compress else None).encode("utf-8")
    if compress:
        raw = gzip.compress(raw, 9, mtime=0)
    data = AESGCM(_keys[k]).encrypt(iv, raw, None)
    enc = {"alg": "AES-GCM", "kdf": "PBKDF2-SHA256", "iter": iterations, "salt": b64(salt), "iv": b64(iv), "data": b64(data)}
    if compress:
        enc["zip"] = "gzip"
    return enc


# ---------------------------------------------------------------------------
# Публикация: ветка data из одного коммита (без истории данных)
# ---------------------------------------------------------------------------

def git(*args: str, cwd: Path = DATA_REPO) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode != 0:
        raise CollectError("GIT", f"git {' '.join(args)}: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout.strip()


def write_days(db, out_dir: Path, password: str, iterations: int, hashes_path: Path | None = None) -> int:
    """Архив по дням для календарика: days/ГГГГ-ММ-ДД.json (строки дня, зашифровано тем же паролем)
    и открытый days/index.json — только даты и время последней сверки с Bitrix.
    Файл дня переписывается, только если изменились его строки. Возвращает число переписанных."""
    import archive
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        hashes = json.loads(hashes_path.read_text(encoding="utf-8")) if hashes_path else {}
    except (OSError, ValueError):
        hashes = {}
    # смена пароля или общей соли → перешифровать всё
    salt = hashlib.sha256(f"{password}\0{iterations}\0{b64(kdf_salt(password, iterations))}".encode("utf-8")).hexdigest()
    index, changed = {}, 0
    for day, checked in archive.days_checked(db):
        rows = archive.day_rows(db, day)
        h = hashlib.sha256((salt + json.dumps(rows, ensure_ascii=False)).encode("utf-8")).hexdigest()
        f = out_dir / f"{day}.json"
        if hashes.get(day) != h or not f.exists():
            enc = encrypt({"day": day, "rows": rows}, password, iterations)
            f.write_text(json.dumps({"v": 1, "day": day, "enc": enc}, ensure_ascii=False), encoding="utf-8")
            hashes[day] = h
            changed += 1
        index[day] = checked
    for f in out_dir.glob("????-??-??.json"):
        if f.stem not in index:              # все задачи дня ушли из Bitrix
            f.unlink()
            hashes.pop(f.stem, None)
    (out_dir / "index.json").write_text(
        json.dumps({"v": 1, "updatedAt": utc_now_iso(), "days": index}, ensure_ascii=False, indent=0), encoding="utf-8")
    if hashes_path:
        hashes_path.write_text(json.dumps(hashes), encoding="utf-8")
    return changed


def publish_days(cfg: dict) -> None:
    import archive
    db = archive.connect(APP_DIR / "archive.sqlite")
    try:
        n = write_days(db, DATA_REPO / "days", cfg["password"], cfg["kdf_iterations"], APP_DIR / "days-published.json")
    finally:
        db.close()
    if n:
        log.info("Архив по дням: переписано файлов %s", n)


def publish_analytics(cfg: dict) -> None:
    """Вкладка «Аналитика»: весь архив одним файлом analytics.json (tools/collector/analytics.py, без описаний задач),
    gzip + шифрование тем же паролем. Файл переписывается, только если изменились данные."""
    import analytics
    import archive
    db = archive.connect(APP_DIR / "archive.sqlite")
    try:
        payload = analytics.build(db, cfg.get("cartographers") or [])
    finally:
        db.close()
    salt = b64(kdf_salt(cfg["password"], cfg["kdf_iterations"]))
    body = {k: v for k, v in payload.items() if k != "generatedAt"}
    h = hashlib.sha256((salt + json.dumps(body, ensure_ascii=False, sort_keys=True)).encode("utf-8")).hexdigest()
    state_path, out = APP_DIR / "analytics-published.json", DATA_REPO / "analytics.json"
    try:
        if json.loads(state_path.read_text(encoding="utf-8")).get("hash") == h and out.exists():
            return
    except (OSError, ValueError):
        pass
    payload["generatedAt"] = datetime.now().strftime("%Y-%m-%dT%H:%M")
    enc = encrypt(payload, cfg["password"], cfg["kdf_iterations"], compress=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"v": 1, "generatedAt": utc_now_iso(), "enc": enc}, ensure_ascii=False), encoding="utf-8")
    state_path.write_text(json.dumps({"hash": h, "at": utc_now_iso()}), encoding="utf-8")
    log.info("Аналитика: analytics.json переписан (%s заказов, %s КБ)", len(payload["tasks"]), round(len(enc["data"]) / 1024))


def publish(cfg: dict, envelope: dict | None) -> None:
    """envelope=None — live.json не трогаем (публикуется только архив по дням)."""
    if not (DATA_REPO / ".git").exists():
        DATA_REPO.mkdir(parents=True, exist_ok=True)
        git("init", "-q")
        git("remote", "add", "origin", cfg["git_remote"])
        git("config", "user.name", "gantt-collector")
        git("config", "user.email", "gantt-collector@users.noreply.github.com")
    if envelope is not None:
        (DATA_REPO / cfg["data_file"]).write_text(json.dumps(envelope, ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA_REPO / "README.md").write_text(
        "Служебная ветка: зашифрованные данные «живой» ленты (live.json), архив по дням (days/) "
        "и вкладка «Аналитика» (analytics.json). "
        "Перезаписывается сборщиком (tools/collector/collect.py), истории нет.\n", encoding="utf-8")
    git("add", "-A")
    # всегда один коммит без родителей: история данных не копится
    tree = git("write-tree")
    commit = git("commit-tree", tree, "-m", f"data {envelope['generatedAt'] if envelope else utc_now_iso()}")
    git("push", "-f", "-q", "origin", f"{commit}:refs/heads/{cfg['data_branch']}")
    log.info("Опубликовано в ветку %s", cfg["data_branch"])


# ---------------------------------------------------------------------------
# Основной цикл
# ---------------------------------------------------------------------------

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def schedule_every(cfg: dict, at: datetime) -> int:
    """Интервал (мин) по расписанию "schedule" на момент at; вне правил и без расписания — interval_min."""
    hm = lambda s: int(s[:2]) * 60 + int(s[3:5])
    m = at.hour * 60 + at.minute
    for r in cfg.get("schedule") or []:
        a, b = hm(r["from"]), hm(r["to"])
        if (a <= m < b) if a < b else (m >= a or m < b):          # правило может переходить через полночь
            return max(int(r["every_min"]), cfg["interval_min"])
    return cfg["interval_min"]


def schedule_due(cfg: dict, now: datetime) -> bool:
    """Пора ли запускаться: с прошлого запуска прошёл интервал расписания (запас 3 мин на неровный старт)."""
    every = schedule_every(cfg, now)
    if every <= cfg["interval_min"]:
        return True
    try:
        last = datetime.fromisoformat(json.loads(SCHEDULE_PATH.read_text(encoding="utf-8"))["last"])
    except (OSError, ValueError, KeyError):
        return True
    return (now - last).total_seconds() / 60 >= every - 3


def published_interval(cfg: dict, now: datetime) -> int:
    """Интервал для сайта (порог «данные не обновлялись»): до следующего запуска — с учётом смены правила,
    например последний дневной запуск в 22:46, следующий — уже по ночному, через час."""
    every = schedule_every(cfg, now)
    return max(every, schedule_every(cfg, now + timedelta(minutes=every)))


def run(cfg: dict, dry_run: bool) -> int:
    if not cfg.get("password"):
        log.error("Не задан пароль шифрования — запустите: python collect.py --setup")
        return 2
    last_ok = json.loads(LAST_OK_PATH.read_text(encoding="utf-8")) if LAST_OK_PATH.exists() else None
    envelope = {"v": 1, "generatedAt": utc_now_iso(), "intervalMin": published_interval(cfg, datetime.now()),
                "source": cfg["source_name"]}
    code = 0
    try:
        with Lock() as lock:
            try:
                migrate_scrub(cfg)
            except Exception:  # noqa: BLE001 — повторится в следующий запуск
                log.exception("Перечистка сохранённых текстов не удалась")
            try:
                migrate_places(cfg)
            except Exception:  # noqa: BLE001 — повторится в следующий запуск
                log.exception("Пересчёт мест в архиве не удался")
            geo_state = load_geo_state() if cfg.get("geo") else None
            res = fetch_tasks(cfg, geo_state)
            geo_part = None
            if geo_state is not None:
                try:
                    import geo
                    geo_part = geo.build(APP_DIR, cfg, res, res.get("geo_todo", []))
                except Exception:  # noqa: BLE001 — без карты лента всё равно публикуется
                    log.exception("Карта топонимов не собрана")
            if cfg.get("archive"):
                try:
                    save_archive(cfg, res, geo_part)
                    if not dry_run:
                        refresh_closed(cfg, res, lock)
                        if cfg.get("publish_days"):
                            publish_days(cfg)
                        if cfg.get("publish_analytics"):
                            publish_analytics(cfg)
                except Exception:  # noqa: BLE001 — архив не должен мешать публикации
                    log.exception("Архив не обновлён")
        payload = {"rows": res["rows"], "now": res["now"], "range": res["range"], "sourceName": cfg["source_name"]}
        if geo_part is not None:
            payload["geo"] = geo_part
        envelope.update({
            "status": "ok", "message": "", "count": res["count"], "range": res["range"], "bitrixNow": res["now"],
            "dataAt": envelope["generatedAt"], "enc": encrypt(payload, cfg["password"], cfg["kdf_iterations"]),
        })
        LAST_OK_PATH.write_text(json.dumps(envelope, ensure_ascii=False), encoding="utf-8")
        if dry_run:
            (APP_DIR / "last-payload.json").write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    except CollectError as e:
        if e.code == "BUSY":
            log.warning(str(e))
            return 0
        log.error("%s: %s", e.code, e)
        code = 3 if e.code == "LOGIN_REQUIRED" else 1
        # публикуем статус, но оставляем последние удачные данные — коллеги видят их с пометкой
        envelope.update({"status": "login_required" if e.code == "LOGIN_REQUIRED" else "error", "message": str(e)})
        if last_ok:
            for k in ("count", "range", "bitrixNow", "dataAt", "enc"):
                envelope[k] = last_ok.get(k)
    except Exception as e:  # noqa: BLE001 — всё неожиданное тоже в статус
        log.exception("Сбой сборщика")
        code = 1
        envelope.update({"status": "error", "message": f"{type(e).__name__}: {e}"})
        if last_ok:
            for k in ("count", "range", "bitrixNow", "dataAt", "enc"):
                envelope[k] = last_ok.get(k)

    if dry_run:
        log.info("dry-run: статус %s, публикация пропущена (%s)", envelope["status"], APP_DIR)
        return code
    try:
        publish(cfg, envelope)
    except CollectError as e:
        log.error("%s: %s", e.code, e)
        return 1
    return code


def llm_retry(cfg: dict, ids: list[str]) -> int:
    """Неудачный анализ (сбой API, отказ модели) сборщик повторяет сам — через 1 и 2 ч, и бросает после 3 попыток.
    Здесь счётчик неудач сбрасывается: следующий запуск снова разберёт эти задачи (текст уже скачан, в Bitrix не ходит).
    Без номеров — все задачи очереди без результата. Работает для задач живого окна (3 дня); старше — llm_archive.py."""
    import geo
    path = APP_DIR / "geo-state.json"
    try:
        with Lock():
            state = load_geo_state()
            reset = []
            for tid, st in state["tasks"].items():
                if "result" in st or (ids and tid not in ids):
                    continue
                if "attempts" in st or "failedAt" in st:
                    st.pop("attempts", None)
                    st.pop("failedAt", None)
                    reset.append(tid)
            if reset:
                geo._save_json(path, state)
    except CollectError as e:
        print(f"{e} — повторите через минуту-две.")
        return 1
    unknown = [i for i in ids if i not in state["tasks"]]
    if reset:
        print(f"Сброшен счётчик неудач у {len(reset)}: {', '.join(reset)}. "
              "Их разберёт следующий запуск сборщика (сразу — python collect.py).")
    else:
        print("Задач с неудачным анализом в очереди нет.")
    if unknown:
        print(f"Нет в очереди живого окна: {', '.join(unknown)} — для старых задач: "
              "python llm_archive.py fetch, затем python llm_archive.py apply --variant B")
    if not cfg.get("llm", False):
        print("Внимание: LLM выключен — анализ не пойдёт, пока не включить: python collect.py --llm on")
    log.info("LLM: повтор анализа вручную — %s", ", ".join(reset) or "нечего сбрасывать")
    return 0


def llm_switch(cfg: dict, mode: str) -> int:
    """«Кнопка стоп» для LLM: пишет "llm" в config.json; действует со следующего запуска сборщика."""
    if mode != "status":
        saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8")) if CONFIG_PATH.exists() else {}
        saved["llm"] = cfg["llm"] = mode == "on"
        save_config(saved)
        log.info("LLM %s вручную", "включён" if cfg["llm"] else "выключен")
    try:
        waiting = sum(1 for v in load_geo_state()["tasks"].values() if "result" not in v and v.get("text"))
    except Exception:  # noqa: BLE001
        waiting = 0
    if cfg.get("llm", False):
        print("LLM включён: новые задачи анализируются" + (f" (в очереди {waiting})" if waiting else "") + ".")
    else:
        print(f"LLM ВЫКЛЮЧЕН: лента и карта по уже разобранным задачам обновляются, новые задачи ждут"
              f" ({waiting}). Включить: python collect.py --llm on")
    return 0


def save_archive(cfg: dict, res: dict, geo_part: dict | None) -> None:
    import archive
    texts = {t["id"]: t["text"] for t in res.get("geo_todo", []) if t.get("text")}
    db = archive.connect(APP_DIR / "archive.sqlite")
    try:
        n = archive.update(db, cfg, res, geo_part, texts)
        frm = datetime.strptime(res["range"]["from"], "%d.%m.%Y %H:%M")
        # дни окна перечитаны целиком — задачи, пропавшие из Bitrix, убираем
        days = [(frm.date() + timedelta(days=i)).isoformat() for i in range(cfg["days"])]
        gone = archive.prune(db, days, {t["id"] for t in res.get("tasks", [])})
        archive.export_closed(db, cfg, frm, archive.archive_dir(cfg))
        log.info("Архив: обновлено задач %s%s", n, f", удалено (нет в Bitrix) {gone}" if gone else "")
    finally:
        db.close()


def migrate_scrub(cfg: dict) -> None:
    """Правила очистки (scrub.VERSION) сменились или ещё не применялись — перечистить уже сохранённое:
    тексты в очереди geo-state.json, описания в archive.sqlite и Excel-выгрузки затронутых дней."""
    import archive
    import scrub
    mark = APP_DIR / "scrub.json"
    try:
        if json.loads(mark.read_text(encoding="utf-8")).get("version") == scrub.VERSION:
            return
    except (OSError, ValueError):
        pass
    state_path = APP_DIR / "geo-state.json"
    n_state = 0
    if state_path.exists():
        state = load_geo_state()
        for st in state.get("tasks", {}).values():
            if st.get("text"):
                new = scrub.clean(st["text"])
                n_state += new != st["text"]
                st["text"] = new
        tmp = state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(state_path)
    n_arch, n_xlsx, days = 0, 0, set()
    if (APP_DIR / "archive.sqlite").exists():
        db = archive.connect(APP_DIR / "archive.sqlite")
        try:
            with db:
                for tid, day, text in db.execute("SELECT id, day, description FROM tasks WHERE description <> ''").fetchall():
                    new = scrub.clean(text)
                    if new != text:
                        db.execute("UPDATE tasks SET description = ? WHERE id = ?", (new, tid))
                        n_arch += 1
                        days.add(day)
            exported = {d for (d,) in db.execute("SELECT day FROM exports")}
            for d in sorted(days & exported):          # в Excel тоже не должно остаться исходного текста
                n_xlsx += bool(archive.export_day(db, cfg, d, archive.archive_dir(cfg)))
        finally:
            db.close()
    mark.write_text(json.dumps({"version": scrub.VERSION, "at": utc_now_iso()}), encoding="utf-8")
    log.info("Очистка текстов (правила v%s): очередь %s, архив %s, Excel перевыгружено %s",
             scrub.VERSION, n_state, n_arch, n_xlsx)


def migrate_places(cfg: dict) -> None:
    """Правила «что это за место» (places.VERSION) сменились или ещё не применялись — пересчитать регион,
    страну и идентификатор места у топонимов архива по координатам (без LLM) и перевыгрузить Excel."""
    import archive
    import places
    mark = APP_DIR / "places.json"
    try:
        if json.loads(mark.read_text(encoding="utf-8")).get("version") == places.VERSION:
            return
    except (OSError, ValueError):
        pass
    n, days, exported = 0, set(), set()
    if (APP_DIR / "archive.sqlite").exists():
        gz = places.Gazetteer.get()
        db = archive.connect(APP_DIR / "archive.sqlite")
        try:
            rows = db.execute("""SELECT p.task_id, p.idx, p.name, p.kind, p.iso, p.lat, p.lon, t.day
                                 FROM toponyms p JOIN tasks t ON t.id = p.task_id""").fetchall()
            with db:
                for tid, idx, name, kind, iso, lat, lon, day in rows:
                    c = places.canon({"name": name, "kind": kind, "iso": iso, "lat": lat, "lon": lon}, gz)
                    db.execute("UPDATE toponyms SET region = ?, country = ?, pid = ? WHERE task_id = ? AND idx = ?",
                               (c["region"], c["country"], c["pid"], tid, idx))
                    n += 1
                    days.add(day)
            exported = {d for (d,) in db.execute("SELECT day FROM exports")}
            for d in sorted(days & exported):
                archive.export_day(db, cfg, d, archive.archive_dir(cfg))
        finally:
            db.close()
    mark.write_text(json.dumps({"version": places.VERSION, "at": utc_now_iso()}), encoding="utf-8")
    log.info("Места (правила v%s): пересчитано топонимов %s, Excel перевыгружено %s",
             places.VERSION, n, len(days & exported))


def refresh_closed(cfg: dict, res: dict, lock: Lock) -> None:
    """Раз в сутки перечитать refresh_days закрытых дней перед окном: статусы на сайте и в Excel — текущие."""
    import archive
    n = int(cfg.get("refresh_days") or 0)
    frm = datetime.strptime(res["range"]["from"], "%d.%m.%Y %H:%M")
    first = frm.date()
    state_path = APP_DIR / "refresh.json"
    try:
        if json.loads(state_path.read_text(encoding="utf-8")).get("day") == first.isoformat():
            return
    except (OSError, ValueError):
        pass
    if n > 0:
        log.info("Обновление статусов: %s закрытых дней", n)
        db = archive.connect(APP_DIR / "archive.sqlite")
        try:
            days = sync_days(cfg, db, first - timedelta(days=n), first - timedelta(days=1), lock)
            archive.reexport(db, cfg, days, frm, archive.archive_dir(cfg))
        finally:
            db.close()
    state_path.write_text(json.dumps({"day": first.isoformat(), "at": utc_now_iso()}), encoding="utf-8")


def backfill(cfg: dict, d_from: date, d_to: date) -> int:
    """Догрузить из Bitrix рабочие дни d_from…d_to (текущие статусы) и опубликовать архив по дням."""
    import archive
    if not cfg.get("password"):
        log.error("Не задан пароль шифрования — запустите: python collect.py --setup")
        return 2
    code = 0
    with Lock() as lock:
        db = archive.connect(APP_DIR / "archive.sqlite")
        try:
            chunks = day_chunks(cfg, d_from, d_to, bitrix_now(cfg))
            log.info("Догрузка %s — %s: кусков %s", d_from, d_to, len(chunks))
            days: list[str] = []
            try:
                days = sync_days(cfg, db, d_from, d_to, lock)
            except CollectError as e:
                log.error("%s: %s — догружено то, что успели", e.code, e)
                code = 3 if e.code == "LOGIN_REQUIRED" else 1
            window_from, _ = date_range(cfg, bitrix_now(cfg))
            archive.reexport(db, cfg, days, window_from, archive.archive_dir(cfg))
            n = write_days(db, DATA_REPO / "days", cfg["password"], cfg["kdf_iterations"], APP_DIR / "days-published.json")
            log.info("Догружено дней %s, файлов архива переписано %s", len(days), n)
        finally:
            db.close()
        if cfg.get("publish_analytics"):
            publish_analytics(cfg)
    try:
        publish(cfg, None)
    except CollectError as e:
        log.error("%s: %s", e.code, e)
        return 1
    return code


def load_geo_state() -> dict:
    try:
        return json.loads((APP_DIR / "geo-state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"tasks": {}}


def setup(cfg: dict) -> None:
    print(f"Настройки: {CONFIG_PATH}")
    while True:
        p1 = getpass.getpass("Пароль для коллег (для расшифровки ленты): ")
        p2 = getpass.getpass("Повторите пароль: ")
        if p1 and p1 == p2:
            break
        print("Пароли пустые или не совпадают, ещё раз.")
    cfg["password"] = p1
    v = input(f"Интервал обновления, мин [{cfg['interval_min']}]: ").strip()
    if v:
        cfg["interval_min"] = max(5, int(v))
    save_config(cfg)
    print("Сохранено. Дальше: python collect.py --login (вход в Bitrix), затем проверка "
          "python collect.py --dry-run -v и только после неё python collect.py --install-task")


def install_task(cfg: dict) -> None:
    pyw = Path(sys.executable).with_name("pythonw.exe")
    exe = pyw if pyw.exists() else Path(sys.executable)
    tr = f'"{exe}" "{Path(__file__).resolve()}"'
    cmd = ["schtasks", "/Create", "/F", "/TN", TASK_NAME, "/SC", "MINUTE", "/MO", str(cfg["interval_min"]), "/TR", tr]
    align = cfg.get("align_minute")
    if align is not None:
        # старт в 00:MM и повтор каждые N минут → запуски в фиксированные минуты часа
        cmd += ["/ST", f"00:{int(align) % 60:02d}"]
    subprocess.run(cmd, check=True)
    when = ""
    if align is not None:
        mins = sorted({(int(align) + k * cfg["interval_min"]) % 60 for k in range(max(1, 60 // cfg["interval_min"]))})
        when = " (в " + ", ".join(f":{m:02d}" for m in mins) + " каждого часа)" if cfg["interval_min"] <= 60 else ""
    print(f"Задача «{TASK_NAME}» будет запускаться каждые {cfg['interval_min']} мин{when}, пока вы вошли в Windows.")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Сборщик живой ленты из Bitrix")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--setup", action="store_true", help="задать пароль и интервал")
    g.add_argument("--login", action="store_true", help="войти в Bitrix в окне Edge")
    g.add_argument("--install-task", action="store_true", help="добавить в Планировщик Windows")
    g.add_argument("--remove-task", action="store_true", help="удалить из Планировщика")
    g.add_argument("--import-geocache", metavar="GEOJSON", help="добавить точки из GeoJSON в кэш координат")
    g.add_argument("--export-day", metavar="ГГГГ-ММ-ДД", help="выгрузить день из архива в Excel (заново)")
    g.add_argument("--llm", choices=["on", "off", "status"], help="включить / выключить анализ задач через Claude")
    g.add_argument("--llm-retry", nargs="*", metavar="ID",
                   help="повторить неудавшийся анализ (все задачи очереди или указанные номера) в следующий запуск")
    g.add_argument("--backfill", nargs="+", metavar="ГГГГ-ММ-ДД",
                   help="догрузить рабочие дни из Bitrix в архив и на сайт: С [ПО] (по умолчанию — по сегодня)")
    p.add_argument("--dry-run", action="store_true", help="собрать без публикации")
    p.add_argument("--force", action="store_true", help="запустить, даже если по расписанию (schedule) ещё рано")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    setup_logging(args.verbose)
    cfg = load_config()
    if args.setup:
        setup(cfg)
        return 0
    if args.login:
        interactive_login(cfg)
        return 0
    if args.install_task:
        install_task(cfg)
        return 0
    if args.import_geocache:
        import geo
        n = geo.GeoCache(APP_DIR / "geocache.json").import_geojson(Path(args.import_geocache))
        print(f"В кэш координат добавлено: {n}")
        return 0
    if args.llm:
        return llm_switch(cfg, args.llm)
    if args.llm_retry is not None:
        return llm_retry(cfg, args.llm_retry)
    if args.export_day:
        import archive
        db = archive.connect(APP_DIR / "archive.sqlite")
        try:
            p = archive.export_day(db, cfg, args.export_day, archive.archive_dir(cfg), record=False)
        finally:
            db.close()
        print(p or f"За {args.export_day} в архиве задач нет")
        return 0
    if args.backfill:
        if len(args.backfill) > 2:
            p.error("--backfill: одна или две даты")
        try:
            d_from = date.fromisoformat(args.backfill[0])
            today = (bitrix_now(cfg) - timedelta(hours=cfg["day_start_hour"])).date()
            d_to = date.fromisoformat(args.backfill[1]) if len(args.backfill) > 1 else today
        except ValueError:
            p.error("--backfill: даты в виде ГГГГ-ММ-ДД")
        if d_from > d_to:
            p.error("--backfill: первая дата позже второй")
        try:
            return backfill(cfg, d_from, d_to)
        except CollectError as e:
            log.error("%s: %s", e.code, e)
            return 1
    if args.remove_task:
        subprocess.run(["schtasks", "/Delete", "/F", "/TN", TASK_NAME], check=False)
        return 0
    # Планировщик (без консоли) — по расписанию "schedule"; запуск из консоли и --force — всегда
    now = datetime.now()
    console = bool(sys.stdout and sys.stdout.isatty())
    if not (console or args.force or args.dry_run) and not schedule_due(cfg, now):
        return 0
    SCHEDULE_PATH.write_text(json.dumps({"last": now.isoformat(timespec="seconds")}), encoding="utf-8")
    return run(cfg, args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
