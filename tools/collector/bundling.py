#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hierarchical edge bundling по локальному архиву (archive.sqlite), две схемы:
  исполнители — профиль (картограф / дизайнер; фамилии картографов — "cartographers" в config.json сборщика)
                → человек; связь — общие заказы;
  топонимы    — страна → регион → топоним (по координатам, places.py), окно в 7 дней;
                связь — встречаются в одном заказе.

    python tools/collector/bundling.py     # → in/bundling.html (в .gitignore: там реальные данные)

Открыть через локальный сервер из корня репозитория: http://localhost:8765/in/bundling.html
Шаблон — tools/collector/bundling.html (d3 с cdn.jsdelivr.net).
"""
import json
import os
import re
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from dashboard import PERSON, short  # noqa: E402

REPO = HERE.parent.parent
DB = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "gantt-collector" / "archive.sqlite"
OUT = REPO / "in" / "bundling.html"
# у водных объектов LLM даёт один тип — без «реки» в названии это море, озеро и т. п.
WATER_WORD = re.compile(r"(?i)море|озер|залив|пролив|океан|водохранилищ|лиман|канал|бухт|губа|река|ручей")
def people(works: str) -> list[str]:
    """«Иванов Иван Иванович (дата) = 2D: …. Петров …» → ["Иванов И. И.", "Петров …"] — все, кто работал над задачей."""
    return sorted({short(n) for n in PERSON.findall(works or "")})


def place(name: str, kind: str, country: str, region: str) -> tuple[str, str]:
    """→ (страна, регион) для иерархии: из колонок архива, которые сборщик считает по координатам (places.py)."""
    if kind == "country":
        return country or name, "страна целиком"
    return country or ("акватории" if kind == "water" else "—"), region or "без региона"


def main() -> int:
    if not DB.exists():
        sys.exit(f"Нет {DB} — архив создаёт сборщик (collect.py)")
    db = sqlite3.connect(DB)
    execs = [{"day": day, "people": ps} for day, works in db.execute("SELECT day, works FROM tasks WHERE day IS NOT NULL")
             if len(ps := people(works)) >= 1]
    tops = {}
    for tid, day, name, kind, country, region, pid in db.execute(
            """SELECT p.task_id, t.day, p.name, p.kind, p.country, p.region, p.pid FROM toponyms p JOIN tasks t ON t.id = p.task_id
               WHERE t.day IS NOT NULL AND p.pid IS NOT NULL ORDER BY p.task_id, p.idx"""):
        country, region = place(name, kind, country, region)
        t = tops.setdefault(tid, {"day": day, "tops": {}})
        t["tops"][pid] = {"name": name, "country": country, "region": region, "pid": pid, "kind": kind}
    db.close()
    # одно название у разных мест (город и река, две деревни) — уточнение в подписи
    pids = {}
    for t in tops.values():
        for x in t["tops"].values():
            pids.setdefault(x["name"], set()).add(x["pid"])
    for t in tops.values():
        for x in t["tops"].values():
            # одноимённые места различаются по подсказке и положению на окружности (страна → регион);
            # уточнение — только у реки, совпадающей по названию с городом («Днепр (река)»)
            if len(pids[x["name"]]) > 1 and x["kind"] == "water" and not WATER_WORD.search(x["name"]):
                x["name"] += " (река)"
            del x["kind"]
    # фамилии картографов — только в локальном config.json сборщика (в репозитории их нет)
    try:
        cart = json.loads((DB.parent / "config.json").read_text(encoding="utf-8")).get("cartographers", [])
    except (OSError, ValueError):
        cart = []
    data = {"execs": execs, "tops": [{"day": t["day"], "tops": list(t["tops"].values())} for t in tops.values()],
            "cartographers": cart}
    page = (HERE / "bundling.html").read_text(encoding="utf-8").replace(
        "__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))
    OUT.write_text(page, encoding="utf-8")
    print(f"{OUT}  (заказов с исполнителями {len(execs)}, с топонимами {len(tops)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
