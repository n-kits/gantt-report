#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ручной разбор мест: подозрительные пары (одно название — разные точки) и точки «оценка модели».
Локальная страница на подложке OpenStreetMap: «Верно» — отметка «проверено», клик по карте или вставка
«широта, долгота» — свои координаты. «Сохранить» дописывает строки в geo-manual.csv и переносит правки
в архив (llm_archive.py manual); живое окно сборщик подхватит сам.

    python tools/collector/geo_manual.py              # http://127.0.0.1:8766/ — откроется в браузере
    python tools/collector/geo_manual.py --no-browser
    python tools/collector/geo_manual.py --port 8767     # другой порт

Сервер слушает только 127.0.0.1; данные (названия задач, места) — из локального архива, в репозиторий не попадают.
"""
from __future__ import annotations

import json
import logging
import sys
import threading
import webbrowser
from collections import defaultdict
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urljoin

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import archive  # noqa: E402
import collect  # noqa: E402
import geo  # noqa: E402
import llm_archive  # noqa: E402
import places  # noqa: E402

log = logging.getLogger("collector")
PORT = 8765
PAGE = HERE / "geo_manual.html"


def region_of(macro: str | None) -> str:
    return (macro or "").split(",")[0].strip()


def collect_items() -> dict:
    """Пары и оценки модели из архива: точки с регионами модели (ключ ручной правки) и задачами."""
    db = archive.connect(collect.APP_DIR / "archive.sqlite")
    try:
        manual = geo.Manual(collect.APP_DIR / geo.MANUAL_NAME)
        base = collect.load_config().get("tasks_url") or ""   # в архиве ссылки относительные — от адреса Bitrix
        topo = db.execute("""SELECT pid, name, kind, macro, src, lat, lon, region, country, task_id
                             FROM toponyms WHERE lat IS NOT NULL""").fetchall()
        tasks = {r[0]: {"id": r[0], "day": r[1], "name": r[2], "project": r[3],
                     "url": urljoin(base, r[4]) if base and r[4] else r[4]}
                 for r in db.execute("SELECT id, day, name, project, url FROM tasks")}
        pairs = places.suspicious(places.archive_rows(db, collect.APP_DIR))
    finally:
        db.close()

    # регионы модели и источники по месту (pid + название): ключи строк geo-manual.csv
    by_pid = defaultdict(lambda: {"macros": set(), "src": set()})
    for pid, name, kind, macro, src, *_ in topo:
        e = by_pid[(pid, geo.norm(name))]
        e["macros"].add(geo.osm_region(region_of(macro)))
        e["src"].add(src or "")

    def task_list(ids):
        return sorted((tasks[t] for t in ids if t in tasks), key=lambda t: t["day"], reverse=True)

    def point(p, kind=None):
        e = by_pid[(p["pid"], geo.norm(p["name"]))]
        return {"name": p["name"], "kind": kind, "region": p["region"], "lat": p["lat"], "lon": p["lon"],
                "macros": sorted(e["macros"]), "src": sorted(x for x in e["src"] if x),
                "checked": bool(p.get("checked")), "tasks": task_list(p["tasks"])}

    out_pairs = [{"id": f"pair:{i}", "name": s["name"], "country": s["country"], "km": s["km"],
                  "points": [point(s["a"]), point(s["b"])]} for i, s in enumerate(pairs)]

    # оценки модели: (название, регион модели) → одна точка; без отметок в geo-manual.csv
    est = {}
    for pid, name, kind, macro, src, lat, lon, region, country, tid in topo:
        if src != "llm" or manual.checked(name, region_of(macro)):
            continue
        k = (geo.norm(name), geo.norm(geo.osm_region(region_of(macro))))
        e = est.setdefault(k, {"name": name, "kind": kind, "macros": [geo.osm_region(region_of(macro))],
                               "region": region, "country": country, "lat": lat, "lon": lon,
                               "src": ["llm"], "ids": set()})
        e["ids"].add(tid)
    # одноимённые оценки (разные регионы в ответе модели) — точки одной карточки: их можно склеить
    by_name = defaultdict(list)
    for e in est.values():
        by_name[geo.norm(e["name"])].append(e)
    out_est = []
    for i, group in enumerate(sorted(by_name.values(), key=lambda g: (-sum(len(e["ids"]) for e in g), g[0]["name"]))):
        group.sort(key=lambda e: -len(e["ids"]))
        for e in group:
            e["tasks"] = task_list(e.pop("ids"))
        out_est.append({"id": f"est:{i}", "name": group[0]["name"], "country": group[0]["country"], "points": group[:10]})
    # все места архива (с координатами): по названию, внутри — разные точки; для поиска и «не топоним»
    names = defaultdict(dict)
    for pid, name, kind, macro, src, lat, lon, region, country, tid in topo:
        e = names[geo.norm(name)].setdefault(pid, {"name": name, "kind": kind, "region": region, "country": country,
                                                   "lat": lat, "lon": lon, "macros": set(), "src": set(), "ids": set()})
        e["macros"].add(geo.osm_region(region_of(macro)))
        e["src"].add(src or "")
        e["ids"].add(tid)
    out_all = []
    for k in sorted(names, key=lambda k: (-sum(len(p["ids"]) for p in names[k].values()), k)):
        pts = sorted(names[k].values(), key=lambda p: -len(p["ids"]))[:10]
        for p in pts:
            p.update(macros=sorted(p["macros"]), src=sorted(x for x in p["src"] if x))
            ts = task_list(p.pop("ids"))
            p["tasks"], p["ntasks"] = ts[:5], len(ts)
        out_all.append({"id": f"all:{len(out_all)}", "name": pts[0]["name"], "country": pts[0]["country"],
                        "n": sum(p["ntasks"] for p in pts), "points": pts})
    return {"pairs": out_pairs, "est": out_est, "all": out_all, "manualPath": str(manual.path),
            "manualCount": len(manual.points), "at": datetime.now().strftime("%d.%m.%Y %H:%M")}


def clean(s) -> str:
    return str(s if s is not None else "").replace(";", ",").replace("\n", " ").strip()


def save_rows(rows: list) -> dict:
    """[[название, регион, широта, долгота, примечание]] → в конец geo-manual.csv (поздняя строка главнее),
    затем правки — в архив."""
    m = geo.Manual(collect.APP_DIR / geo.MANUAL_NAME)
    m.ensure()
    lines = []
    for r in rows:
        name, region, lat, lon, note = (list(r) + [""] * 5)[:5]
        if not clean(name):
            continue
        if geo.norm(str(lat or "")) in geo.NOT_PLACE_WORDS:
            coords = [geo.NOT_PLACE, ""]
        elif lat not in ("", None) and lon not in ("", None):
            coords = [f"{float(lat):.5f}", f"{float(lon):.5f}"]
        else:
            coords = ["", ""]
        lines.append(";".join([clean(name), clean(region), *coords, clean(note)]))
    if not lines:
        return {"saved": 0}
    text = m.path.read_text(encoding="utf-8-sig")
    with open(m.path, "a", encoding="utf-8", newline="") as f:
        f.write(("" if text.endswith("\n") or not text else "\n") + "\n".join(lines) + "\n")
    log.info("Ручной разбор: в %s добавлено строк %s", m.path.name, len(lines))
    llm_archive.manual(collect.load_config())
    return {"saved": len(lines)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] == "/":
            data = json.dumps(collect_items(), ensure_ascii=False).replace("</", "<\\/")
            self._send(200, PAGE.read_text(encoding="utf-8").replace("__DATA__", data).encode("utf-8"),
                       "text/html; charset=utf-8")
        elif self.path.startswith("/region?"):
            # регион и страна новой точки — так же, как их потом посчитает архив (places.py, по координатам)
            from urllib.parse import parse_qs
            q = parse_qs(self.path.split("?", 1)[1])
            try:
                c = places.canon({"name": "", "kind": "settlement", "lat": float(q["lat"][0]), "lon": float(q["lon"][0])})
                body = {"region": c["region"], "country": c["country"]}
            except (KeyError, ValueError):
                body = {}
            self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), "application/json")
        else:
            self._send(404, b"", "text/plain")

    def do_POST(self):  # noqa: N802
        if self.path != "/save":
            return self._send(404, b"", "text/plain")
        try:
            rows = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"[]")
            res = save_rows(rows)
            self._send(200, json.dumps(res).encode(), "application/json")
        except Exception as e:  # noqa: BLE001 — показать на странице
            log.exception("Ручной разбор: не сохранилось")
            self._send(500, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"), "application/json")

    def log_message(self, *a):
        pass


def main() -> int:
    collect.setup_logging(True)
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else PORT
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    log.info("Ручной разбор мест: %s (остановить — Ctrl+C)", url)
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
