#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Пример дэшборда по локальному архиву (archive.sqlite): заказы по дням, проекты, виды продукции,
время выполнения и соблюдение срока, исполнители (по «Выполнению задачи»), темы и регионы из анализа LLM.

    python tools/collector/dashboard.py     # → in/dashboard.html (в .gitignore: там реальные задачи)

Открыть через локальный сервер из корня репозитория: http://localhost:8765/in/dashboard.html
Шаблон страницы — tools/collector/dashboard.html; данные встраиваются в неё, на сайт не публикуются.
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DB = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "gantt-collector" / "archive.sqlite"
OUT = REPO / "in" / "dashboard.html"

# «Иванов Иван Иванович (27.09.2026 20:55) = 2D: …; КГ: …» — по блоку на каждого, кто работал над задачей
PERSON = re.compile(r"([А-ЯЁ][а-яё\-]+(?:\s+[А-ЯЁ][а-яё\-]+){1,2})\s*\(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}\)\s*=")


def short(name):
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


def main() -> int:
    if not DB.exists():
        sys.exit(f"Нет {DB} — архив создаёт сборщик (collect.py)")
    db = sqlite3.connect(DB)
    analysis = {tid: (themes, conflict, sentiment) for tid, themes, conflict, sentiment in
                db.execute("SELECT task_id, themes, conflict, sentiment FROM analysis")}
    macros = {}       # регион места по координатам (places.py); у стран и вне регионов — страна
    for tid, region, country in db.execute("SELECT task_id, region, country FROM toponyms ORDER BY task_id, idx"):
        macros.setdefault(tid, []).append(region or country or "")
    rows = []
    for (tid, day, status, start, finish, executor, deadline, project, product, works, last_seen) in db.execute(
            """SELECT id, day, status, start, finish, executor, deadline, project, product, works, last_seen
               FROM tasks WHERE day IS NOT NULL ORDER BY day, id"""):
        works = works or ""
        a = analysis.get(tid)
        rows.append({
            "id": tid, "day": day, "status": status or "", "start": iso(parse_dt(start)),
            "finish": iso(parse_dt(finish)), "deadline": iso(parse_dt(deadline)),
            "exec": executor or "—", "project": project or "—", "product": product or "—",
            "workers": sorted({short(n) for n in PERSON.findall(works)}),
            "themes": [t for t in (a[0] or "").split(" / ") if t] if a else None,
            "conflict": (a[1] or "") if a else None,
            "sentiment": (a[2] or "") if a else None,
            "macros": [m for m in macros.get(tid, []) if m] if a else None,
            "seen": last_seen,
        })
    db.close()
    data = {"generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M"), "tasks": rows}
    page = (HERE / "dashboard.html").read_text(encoding="utf-8").replace(
        "__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    OUT.write_text(page, encoding="utf-8")
    print(f"{OUT}  (задач {len(rows)}, {rows[0]['day'] if rows else '—'} — {rows[-1]['day'] if rows else '—'}, "
          f"с анализом {sum(1 for r in rows if r['themes'] is not None)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
