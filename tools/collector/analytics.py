#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Данные вкладки «Аналитика» (дашборд + «Связи») по локальному архиву (archive.sqlite) — одним объектом:
это будущий analytics.json в ветке data (issue #4: один файл, сжатие до шифрования, одна расшифровка).

    python tools/collector/analytics.py     # → in/analytics.html — тестовый стенд (в .gitignore: реальные данные)

Открыть через локальный сервер из корня репозитория: http://localhost:8765/in/analytics.html
Код вкладки — js/analytics/*.js и css/analytics.css, разметка — в index.html между метками analytics:begin/end
(общая с главной), обёртка стенда — tools/collector/analytics.html. Фамилии картографов — "cartographers" в config.json сборщика, в репозиторий не попадают.
"""
import base64
import gzip
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent

# «Иванов Иван Иванович (27.09.2026 20:55) = 2D: …; КГ: …» — по блоку на каждого, кто работал над задачей
PERSON = re.compile(r"([А-ЯЁ][а-яё\-]+(?:\s+[А-ЯЁ][а-яё\-]+){1,2})\s*\(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}\)\s*=")


def short(name: str) -> str:
    """«Иванов Иван Иванович» → «Иванов И. И.»"""
    p = name.split()
    return " ".join([p[0]] + [x[0] + "." for x in p[1:]])


def parse_dt(s):
    for fmt in ("%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except (TypeError, ValueError):
            continue
    return None


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M") if dt else None


REPO = HERE.parent.parent
DB = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "gantt-collector" / "archive.sqlite"
OUT = REPO / "in" / "analytics.html"
# у водных объектов LLM даёт один тип — без «реки» в названии это море, озеро и т. п.
WATER_WORD = re.compile(r"(?i)море|озер|залив|пролив|океан|водохранилищ|лиман|канал|бухт|губа|река|ручей")


def build(db: sqlite3.Connection, cartographers: list[str]) -> dict:
    """Всё для вкладки «Аналитика» — без описаний задач (их наружу не публикуем):
    days     — {день: когда статусы дня последний раз сверены с Bitrix};
    people   — {«Иванов И. И.»: профиль} — все, кто есть в «Выполнении задачи»;
    places   — {pid: место} — регион и страна по координатам (places.py), подпись с «(река)» у омонимов;
    tasks    — заказы: поля ленты, исполнители, анализ LLM (темы, конфликт) и ссылки на места."""
    analysis = {tid: (themes, conflict) for tid, themes, conflict in db.execute("SELECT task_id, themes, conflict FROM analysis")}
    places, task_places = {}, {}
    for tid, name, kind, country, region, pid in db.execute(
            "SELECT task_id, name, kind, country, region, pid FROM toponyms WHERE pid IS NOT NULL ORDER BY task_id, idx"):
        places.setdefault(pid, {"name": name, "kind": kind, "country": country or "", "region": region or ""})
        ps = task_places.setdefault(tid, [])
        if pid not in ps:
            ps.append(pid)
    # одно название у разных мест: различаются положением на окружности и подсказкой,
    # уточнение — только у реки, совпадающей по названию с городом («Днепр (река)»)
    names = {}
    for pid, p in places.items():
        names.setdefault(p["name"], set()).add(pid)
    for p in places.values():
        if len(names[p["name"]]) > 1 and p["kind"] == "water" and not WATER_WORD.search(p["name"]):
            p["name"] += " (река)"

    people, tasks = {}, []
    for tid, day, status, start, finish, deadline, project, product, works in db.execute(
            """SELECT id, day, status, start, finish, deadline, project, product, works
               FROM tasks WHERE day IS NOT NULL ORDER BY day, id"""):
        workers = sorted({short(n) for n in PERSON.findall(works or "")})
        for w in workers:
            people[w] = "Картограф" if w.split()[0] in cartographers else "Дизайнер"
        a = analysis.get(tid)
        t = {"id": tid, "day": day, "status": status or "", "start": iso(parse_dt(start)),
             "finish": iso(parse_dt(finish)), "deadline": iso(parse_dt(deadline)),
             "project": project or "—", "product": product or "—", "workers": workers,
             "an": {"themes": [x for x in (a[0] or "").split(" / ") if x], "conflict": a[1] or ""} if a else None}
        if task_places.get(tid):
            t["places"] = task_places[tid]
        tasks.append(t)
    days = {day: checked for day, checked in db.execute(
        "SELECT day, MAX(last_seen) FROM tasks WHERE day IS NOT NULL GROUP BY day ORDER BY day")}
    return {"v": 1, "generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M"), "days": days,
            "people": people, "places": places, "tasks": tasks}


def sizes(payload: dict) -> tuple[int, int, int]:
    """(JSON, после gzip, зашифрованный конверт в base64) — сколько скачает браузер."""
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    gz = gzip.compress(raw, 9)
    return len(raw), len(gz), len(base64.b64encode(gz + b"\0" * 16))     # + тег AES-GCM


def main() -> int:
    if not DB.exists():
        sys.exit(f"Нет {DB} — архив создаёт сборщик (collect.py)")
    try:
        cart = json.loads((DB.parent / "config.json").read_text(encoding="utf-8")).get("cartographers", [])
    except (OSError, ValueError):
        cart = []
    db = sqlite3.connect(DB)
    try:
        payload = build(db, cart)
    finally:
        db.close()
    # разметка вкладки — одна на главную и стенд: берём её из index.html между метками
    index = (REPO / "index.html").read_text(encoding="utf-8")
    panel = index[index.index("<!-- analytics:begin -->") + len("<!-- analytics:begin -->"):index.index("<!-- analytics:end -->")]
    page = (HERE / "analytics.html").read_text(encoding="utf-8").replace("__PANEL__", panel.strip("\r\n") + "\n").replace(
        "__DATA__", json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/"))
    OUT.write_text(page, encoding="utf-8")
    raw, gz, enc = sizes(payload)
    days = list(payload["days"])
    print(f"{OUT}\n  заказов {len(payload['tasks'])}, {days[0] if days else '—'} — {days[-1] if days else '—'}; "
          f"людей {len(payload['people'])}, мест {len(payload['places'])}\n"
          f"  analytics.json: {raw / 1024:.0f} КБ, после gzip {gz / 1024:.0f} КБ, в конверте около {enc / 1024:.0f} КБ")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
