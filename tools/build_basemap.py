"""
Подложка карты: полигоны стран из GeoJSON → компактный data/basemap.json.

    python tools/build_basemap.py in/analyze_geocode/cntpol10.geojson

Страны с одинаковым ISO (США, Франция, Великобритания разбиты на части) объединяются.
Координаты округляются до 0.01° (~1 км), подряд идущие дубли выбрасываются.
Формат: {"countries": [{"iso": "RUS", "name": "Россия", "polys": [[[lon, lat, lon, lat, ...], дыра...], ...]}]}
"""
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "basemap.json"
PREC = 2


def ring_flat(ring):
    out, prev = [], None
    for lon, lat, *_ in ring:
        p = (round(lon, PREC), round(lat, PREC))
        if p != prev:
            out.extend(p)
            prev = p
    return out if len(out) >= 8 else None  # меньше 4 точек — вырожденное кольцо


def polygons(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def main(src):
    fc = json.loads(Path(src).read_text(encoding="utf-8"))
    by_iso = {}
    for f in fc["features"]:
        p = f["properties"]
        iso = p.get("ISO") or p.get("NAME_ENG")
        c = by_iso.setdefault(iso, {"iso": iso, "name": p.get("NAME_RUS_S") or p.get("NAME_RUS") or p.get("NAME_ENG"), "polys": []})
        for poly in polygons(f["geometry"]):
            rings = [r for r in (ring_flat(r) for r in poly) if r]
            if rings:
                c["polys"].append(rings)
    countries = sorted(by_iso.values(), key=lambda c: c["iso"])
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"countries": countries}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n = sum(len(r) // 2 for c in countries for p in c["polys"] for r in p)
    print(f"{OUT}: {len(countries)} стран, {n} точек, {OUT.stat().st_size // 1024} КБ")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "in/analyze_geocode/cntpol10.geojson")
