#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Справочник регионов для определения «где это» по координатам (tools/collector/places.py):
Natural Earth admin-1 (1:10 млн) → data/admin1.json.gz — упрощённые границы, русские названия
регионов и стран, единое правило для спорных территорий.

    python tools/build_admin1.py in/analyze_geocode/ne_10m_admin_1_states_provinces.geojson \
        in/analyze_geocode/cntpol10.geojson

Источник: https://github.com/nvkelso/natural-earth-vector (public domain); русские названия стран —
cntpol10 (короткое NAME_RUS_S), регионов — name_ru из Natural Earth с правками ниже.
"""
import gzip
import json
import sys
from pathlib import Path

from shapely.geometry import mapping, shape

OUT = Path(__file__).resolve().parent.parent / "data" / "admin1.json.gz"
SIMPLIFY = 0.03        # градусов (~3 км): для «в каком регионе точка» точнее не нужно
DIGITS = 2

# Спорные территории — Россия (решение редакции); названия — как в русских СМИ
POLICY = {
    "UA-43": ("Республика Крым", "RUS"),
    "UA-40": ("Севастополь", "RUS"),
    "UA-14": ("Донецкая область", "RUS"),
    "UA-09": ("Луганская область", "RUS"),
    "UA-23": ("Запорожская область", "RUS"),
    "UA-65": ("Херсонская область", "RUS"),
}
# названия регионов, которые в Natural Earth расходятся с привычными
RENAME = {
    "RU-TA": "Республика Татарстан", "RU-BA": "Республика Башкортостан", "RU-DA": "Республика Дагестан",
    "RU-BU": "Республика Бурятия", "RU-CE": "Чеченская Республика", "RU-SA": "Республика Саха (Якутия)",
    "RU-TY": "Республика Тыва", "RU-KO": "Республика Коми", "RU-KR": "Республика Карелия",
    "RU-MO": "Республика Мордовия", "RU-UD": "Удмуртская Республика", "RU-CU": "Чувашская Республика",
    "RU-ME": "Республика Марий Эл", "RU-AL": "Республика Алтай", "RU-KK": "Республика Хакасия",
    "RU-AD": "Республика Адыгея", "RU-IN": "Республика Ингушетия", "RU-KB": "Кабардино-Балкарская Республика",
    "RU-KC": "Карачаево-Черкесская Республика", "RU-SE": "Республика Северная Осетия — Алания",
    "RU-KL": "Республика Калмыкия", "RU-ALT": "Алтайский край",
    "UA-32": "Киевская область",      # в Natural Earth область подписана «Киев», как и сам город (UA-30)
    # в Natural Earth коды Москвы перепутаны (RU-MOS — город, RU-MOW — область), а name_ru верные — их не трогаем
}


def round_coords(obj):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], DIGITS), round(obj[1], DIGITS)]
        return [round_coords(x) for x in obj]
    return obj


def main(ne_path: str, countries_path: str) -> int:
    ru = {}
    for f in json.loads(Path(countries_path).read_text(encoding="utf-8"))["features"]:
        p = f["properties"]
        name = p.get("NAME_RUS_S") or p.get("NAME_RUS")      # короткое: «Сирия», «США», «Великобритания»
        if p.get("ISO") and name:
            ru[p["ISO"]] = name
    ru.setdefault("RUS", "Россия")
    out = []
    for f in json.loads(Path(ne_path).read_text(encoding="utf-8"))["features"]:
        p = f["properties"]
        code = p.get("iso_3166_2") or p.get("adm1_code")
        a3 = p.get("adm0_a3") or ""
        name = RENAME.get(code) or p.get("name_ru") or p.get("name") or ""
        if not name:
            continue                  # безымянные клочки (например, RU-X01~)
        if code in POLICY:
            name, a3 = POLICY[code]
        g = shape(f["geometry"]).simplify(SIMPLIFY, preserve_topology=True)
        if g.is_empty:
            continue
        out.append({"code": code, "name": name, "iso": a3, "country": ru.get(a3) or p.get("admin") or a3,
                    "geometry": round_coords(mapping(g))})
    body = json.dumps({"source": "Natural Earth admin-1 10m; спорные территории — Россия",
                       "regions": out}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    OUT.write_bytes(gzip.compress(body, 9, mtime=0))
    print(f"{OUT}: регионов {len(out)}, {OUT.stat().st_size / 1e6:.1f} МБ")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
