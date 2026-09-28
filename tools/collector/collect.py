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

Всё локальное (настройки, профиль Edge, журнал) — в %LOCALAPPDATA%\\gantt-collector.
Зависимости: playwright, cryptography; браузер — установленный Microsoft Edge.
"""
from __future__ import annotations

import argparse
import base64
import getpass
import json
import logging
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
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
LOG_PATH = APP_DIR / "collector.log"
TASK_NAME = "GanttCollector"

DEFAULTS = {
    "tasks_url": "https://crm.emg24.ru/company/personal/user/609/tasks/?F_FILTER_SWITCH_PRESET=2460",
    "source_name": "Bitrix · ВСЕ КАРТЫ Р24",
    "days": 3,                  # диапазон: последние N суток по времени регистрации
    "day_start_hour": 4,        # сутки начинаются в 04:00, как ось ленты
    "utc_offset_hours": 3,      # время пользователя Bitrix (МСК)
    "interval_min": 60,         # период запуска в Планировщике
    "git_remote": "https://github.com/n-kits/gantt-report.git",
    "data_branch": "data",
    "data_file": "live.json",
    "kdf_iterations": 250000,
    "password": None,           # пароль шифрования для коллег (задаётся --setup)
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
    """Не даём двум запускам (Планировщик + ручной) работать одновременно."""

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


def range_url(cfg: dict, frm: datetime, to: datetime) -> str:
    params = {
        "FILTER_DATE_AFTER_RANGE": fmt_bx(frm),
        "FILTER_DATE_BEFORE_RANGE": fmt_bx(to),
        "FILTER_DATE_PRESET_RANGE": "random_interval",
        "FILTER_DATE_OPTION_VALUE_RANGE": "created_date",
        "SHOWALL_1": "1",
    }
    sep = "&" if "?" in cfg["tasks_url"] else "?"
    return cfg["tasks_url"] + sep + "&".join(f"{k}={quote(v)}" for k, v in params.items())


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


def fetch_tasks(cfg: dict) -> dict:
    from playwright.sync_api import sync_playwright

    now = bitrix_now(cfg)
    frm, to = date_range(cfg, now)
    url = range_url(cfg, frm, to)
    with sync_playwright() as pw:
        ctx = open_context(pw, headless=True)
        try:
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
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
        finally:
            ctx.close()


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


def encrypt(payload: dict, password: str, iterations: int) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations).derive(password.encode("utf-8"))
    data = AESGCM(key).encrypt(iv, json.dumps(payload, ensure_ascii=False).encode("utf-8"), None)
    return {"alg": "AES-GCM", "kdf": "PBKDF2-SHA256", "iter": iterations, "salt": b64(salt), "iv": b64(iv), "data": b64(data)}


# ---------------------------------------------------------------------------
# Публикация: ветка data из одного коммита (без истории данных)
# ---------------------------------------------------------------------------

def git(*args: str, cwd: Path = DATA_REPO) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode != 0:
        raise CollectError("GIT", f"git {' '.join(args)}: {r.stderr.strip() or r.stdout.strip()}")
    return r.stdout.strip()


def publish(cfg: dict, envelope: dict) -> None:
    if not (DATA_REPO / ".git").exists():
        DATA_REPO.mkdir(parents=True, exist_ok=True)
        git("init", "-q")
        git("remote", "add", "origin", cfg["git_remote"])
        git("config", "user.name", "gantt-collector")
        git("config", "user.email", "gantt-collector@users.noreply.github.com")
    (DATA_REPO / cfg["data_file"]).write_text(json.dumps(envelope, ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA_REPO / "README.md").write_text(
        "Служебная ветка: зашифрованные данные «живой» ленты. Перезаписывается сборщиком "
        "(tools/collector/collect.py), истории нет.\n", encoding="utf-8")
    git("add", "-A")
    # всегда один коммит без родителей: история данных не копится
    tree = git("write-tree")
    commit = git("commit-tree", tree, "-m", f"data {envelope['generatedAt']}")
    git("push", "-f", "-q", "origin", f"{commit}:refs/heads/{cfg['data_branch']}")
    log.info("Опубликовано в ветку %s", cfg["data_branch"])


# ---------------------------------------------------------------------------
# Основной цикл
# ---------------------------------------------------------------------------

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(cfg: dict, dry_run: bool) -> int:
    if not cfg.get("password"):
        log.error("Не задан пароль шифрования — запустите: python collect.py --setup")
        return 2
    last_ok = json.loads(LAST_OK_PATH.read_text(encoding="utf-8")) if LAST_OK_PATH.exists() else None
    envelope = {"v": 1, "generatedAt": utc_now_iso(), "intervalMin": cfg["interval_min"], "source": cfg["source_name"]}
    code = 0
    try:
        with Lock():
            res = fetch_tasks(cfg)
        payload = {"rows": res["rows"], "now": res["now"], "range": res["range"], "sourceName": cfg["source_name"]}
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
    subprocess.run(["schtasks", "/Create", "/F", "/TN", TASK_NAME, "/SC", "MINUTE", "/MO", str(cfg["interval_min"]),
                    "/TR", tr], check=True)
    print(f"Задача «{TASK_NAME}» будет запускаться каждые {cfg['interval_min']} мин (пока вы вошли в Windows).")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Сборщик живой ленты из Bitrix")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--setup", action="store_true", help="задать пароль и интервал")
    g.add_argument("--login", action="store_true", help="войти в Bitrix в окне Edge")
    g.add_argument("--install-task", action="store_true", help="добавить в Планировщик Windows")
    g.add_argument("--remove-task", action="store_true", help="удалить из Планировщика")
    p.add_argument("--dry-run", action="store_true", help="собрать без публикации")
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
    if args.remove_task:
        subprocess.run(["schtasks", "/Delete", "/F", "/TN", TASK_NAME], check=False)
        return 0
    return run(cfg, args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
