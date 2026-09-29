"""
Тестовые живые данные с картой: tests/fixtures/live-sample.json (пароль «test»)
+ выдуманный раздел geo → tests/fixtures/live-geo-sample.json.

    python tools/collector/make_geo_sample.py
Просмотр: http://localhost:8766/?data=tests/fixtures/live-geo-sample.json
"""
import base64
import json
import re
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

import collect

FIX = Path(__file__).resolve().parent.parent.parent / "tests" / "fixtures"


def pt(name, lat, lon, kind="settlement", **kw):
    return dict(name=name, kind=kind, lat=lat, lon=lon, **kw)


def country(name, iso):
    return dict(name=name, kind="country", iso=iso)


# первые 5 задач выборки — 26–27.09 («вчера-позавчера»), остальные — 28.09 («сегодня»)
OLD = [
    [country("Венесуэла", "VEN"), pt("Каракас", 10.4806, -66.9036)],
    [pt("Токио", 35.6762, 139.6503), country("Япония", "JPN")],
    [pt("Курск", 51.7304, 36.1926), pt("Суджа (Курская область)", 51.1906, 35.2728, approx=True)],
    [pt("Москва", 55.7558, 37.6173), pt("Каир", 30.0444, 31.2357)],
    [],
]
TODAY = [
    [pt("Москва", 55.7558, 37.6173), pt("Уфа", 54.7261, 55.9475), pt("Новосибирск", 55.0288, 82.9227)],
    [pt("Москва", 55.7558, 37.6173), pt("Сочи", 43.5855, 39.7231)],
    [country("Украина", "UKR"), pt("Покровск (Донецкая область)", 48.282, 37.1758), pt("Мирноград (Донецкая область)", 48.3006, 37.2658)],
    [pt("Чёрное море", 43.4, 34.0, "water")],
    [country("Израиль", "ISR"), pt("Газа", 31.5017, 34.4668), pt("Бейрут", 33.8938, 35.5018)],
    [pt("Москва", 55.7558, 37.6173)],
    [pt("Покровск (Донецкая область)", 48.282, 37.1758)],
]


def main():
    env = json.loads((FIX / "live-sample.json").read_text(encoding="utf-8"))
    enc = env["enc"]
    b = base64.b64decode
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b(enc["salt"]), iterations=enc["iter"]).derive(b"test")
    payload = json.loads(AESGCM(key).decrypt(b(enc["iv"]), b(enc["data"]), None))
    rows = sorted(payload["rows"], key=lambda r: collect_dt(r[2]))
    items = []
    for i, r in enumerate(rows):
        tops = OLD[i] if i < len(OLD) else TODAY[(i - len(OLD)) % len(TODAY)] if i - len(OLD) < 2 * len(TODAY) else []
        m = re.search(r"#(\d+)\s*$", r[0])
        items.append(dict(id=m.group(1) if m else "", start=r[2], theme="", conflict="", sentiment="", toponyms=tops))
    payload["geo"] = {"v": 1, "items": items}
    out = {k: v for k, v in env.items() if k != "enc"}
    out["source"] = "Bitrix · тестовые данные с картой"
    out["enc"] = collect.encrypt(payload, "test", enc["iter"])
    (FIX / "live-geo-sample.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{FIX / 'live-geo-sample.json'}: задач {len(items)}, с топонимами {sum(1 for i in items if i['toponyms'])}")


def collect_dt(s):
    d, t = s.split(" ")
    dd, mm, yy = d.split(".")
    return f"{yy}{mm}{dd}{t}"


if __name__ == "__main__":
    main()
