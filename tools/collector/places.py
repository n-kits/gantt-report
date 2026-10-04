#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
«Что это за место» — по координатам, а не по тексту LLM.

  * регион и страна — из справочника границ data/admin1.json.gz (Natural Earth, собирает
    tools/build_admin1.py): одна формулировка для всех заказов и одно правило для спорных
    территорий (Крым, Севастополь, Донецкая, Луганская, Запорожская, Херсонская области — Россия);
  * идентификатор места (pid): населённый пункт — название + регион («Казань / Татарстан» и
    «Казань / Республика Татарстан» от LLM — одно место); территория или объект — название + страна;
    водный объект — название; страна — код. Днепр-город и Днепр-река — разные места;
  * подозрительные пары — одно название в разных местах одной страны (на проверку).

Текст региона от LLM остаётся только подсказкой геокодеру.

    python tools/collector/places.py --check     # подозрительные пары по локальному архиву
"""
from __future__ import annotations

import gzip
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADMIN1 = HERE.parent.parent / "data" / "admin1.json.gz"

# версия правил: сменилась — сборщик один раз пересчитывает регионы и pid в архиве (collect.migrate_places)
VERSION = 1
SUSPICIOUS_KM = 30          # одно название дальше этого в одной стране — на проверку
KIND_LABEL = {"water": "водный объект", "region": "регион", "country": "страна"}


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", str(s or "").lower().replace("ё", "е")).strip()


def km(a, b) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(min(1, math.sqrt(h)))


class Gazetteer:
    """Регион и страна по точке. Загружается один раз (≈1–2 с), дальше — индекс STRtree."""

    _inst: "Gazetteer | None" = None

    def __init__(self, path: Path = ADMIN1):
        from shapely import STRtree
        from shapely.geometry import shape
        self.regions = json.loads(gzip.decompress(path.read_bytes()))["regions"]
        self.geoms = [shape(r["geometry"]) for r in self.regions]
        self.tree = STRtree(self.geoms)
        self.countries = {}
        for r in self.regions:
            self.countries.setdefault(r["iso"], r["country"])
        self.region_names = defaultdict(list)          # iso → [названия регионов]
        for r in self.regions:
            if r["name"] not in self.region_names[r["iso"]]:
                self.region_names[r["iso"]].append(r["name"])

    @classmethod
    def get(cls) -> "Gazetteer":
        if cls._inst is None:
            cls._inst = cls()
        return cls._inst

    def locate(self, lat, lon) -> dict | None:
        """→ {code, region, iso, country} или None (море, океан, точка без координат)."""
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            return None
        from shapely.geometry import Point
        pt = Point(lon, lat)
        hits = self.tree.query(pt, predicate="intersects")
        if not len(hits):
            # у побережья упрощённая граница может «срезать» точку — берём ближайший регион до ~10 км
            near = self.tree.query_nearest(pt, max_distance=0.1)
            if not len(near):
                return None
            hits = near
        r = self.regions[min(hits, key=lambda i: self.geoms[i].area)]
        return {"code": r["code"], "region": r["name"], "iso": r["iso"], "country": r["country"]}

    def country_name(self, iso: str) -> str:
        return self.countries.get((iso or "").upper(), "")


def canon(p: dict, gz: Gazetteer | None = None) -> dict:
    """
    Топоним (name, kind, lat/lon или iso) → {pid, region, country, rcode}.
    pid — один на место: тип (место / водный объект / регион / страна) + название + регион.
    """
    gz = gz or Gazetteer.get()
    name, kind = norm(p.get("name")), p.get("kind") or "other"
    if kind == "country":
        iso = (p.get("iso") or p.get("country") or "").upper()
        country = gz.country_name(iso) or p.get("name") or ""
        return {"pid": f"country:{iso or name}", "region": "", "country": country, "rcode": ""}
    loc = gz.locate(p.get("lat"), p.get("lon"))
    region, country, code = (loc["region"], loc["country"], loc["code"]) if loc else ("", "", "")
    if kind == "water":
        # реки и моря тянутся через регионы — место определяет название
        return {"pid": f"water:{name}", "region": "", "country": country, "rcode": code}
    if kind in ("region", "other"):
        # территории и объекты («Урал», «Русская равнина», АЭС): LLM путает region/other и каждый раз
        # ставит центр по-разному — место определяют название и страна
        iso = loc["iso"] if loc else (p.get("iso") or p.get("country") or "")
        return {"pid": f"area:{name}:{iso}", "region": region, "country": country, "rcode": code}
    if not code and isinstance(p.get("lat"), (int, float)):
        code = f"{p['lat']:.0f},{p['lon']:.0f}"          # вне границ (остров, шельф) — по градусной клетке
    return {"pid": f"place:{name}:{code}", "region": region, "country": country, "rcode": code}


def region_enum(gz: Gazetteer | None = None) -> list[str]:
    """Закрытый список регионов для ответа LLM: субъекты РФ (с новыми) и области Украины."""
    gz = gz or Gazetteer.get()
    return sorted(set(gz.region_names.get("RUS", []) + gz.region_names.get("UKR", [])))


def suspicious(rows) -> list[dict]:
    """
    rows: [(pid, name, kind, country, region, lat, lon, task_id)] → пары «одно название — разные места»
    в одной стране дальше SUSPICIOUS_KM (две деревни или ошибка LLM / геокодера).
    """
    groups = defaultdict(dict)                      # (имя, класс, страна) → {pid: {...}}
    for pid, name, kind, country, region, lat, lon, tid in rows:
        if kind in ("country", "water") or not isinstance(lat, (int, float)):
            continue
        g = groups[(norm(name), "area" if kind in ("region", "other") else "place", country or "")]
        e = g.setdefault(pid, {"pid": pid, "name": name, "region": region, "lat": lat, "lon": lon, "tasks": set()})
        e["tasks"].add(tid)
    out = []
    for (_, _, country), places in groups.items():
        ps = list(places.values())
        for i in range(len(ps)):
            for j in range(i + 1, len(ps)):
                d = km((ps[i]["lat"], ps[i]["lon"]), (ps[j]["lat"], ps[j]["lon"]))
                if d > SUSPICIOUS_KM:
                    out.append({"name": ps[i]["name"], "country": country, "km": round(d), "a": ps[i], "b": ps[j]})
    return sorted(out, key=lambda x: -x["km"])


def _check() -> int:
    import os
    import archive
    db = archive.connect(Path(os.environ.get("LOCALAPPDATA", Path.home())) / "gantt-collector" / "archive.sqlite")
    rows = db.execute("SELECT pid, name, kind, country, region, lat, lon, task_id FROM toponyms WHERE pid IS NOT NULL").fetchall()
    if not rows:
        print("В архиве ещё нет регионов по координатам — их посчитает следующий запуск сборщика (collect.py)")
        return 0
    found = suspicious(rows)
    if not found:
        print("Подозрительных пар нет")
    for s in found:
        a, b = s["a"], s["b"]
        print(f"{s['name']} ({s['country']}): {a['region']} — {b['region']}, {s['km']} км; "
              f"задачи {', '.join(sorted(a['tasks']))} / {', '.join(sorted(b['tasks']))}")
    return 0


if __name__ == "__main__":
    if "--check" in sys.argv:
        raise SystemExit(_check())
    print(__doc__)
