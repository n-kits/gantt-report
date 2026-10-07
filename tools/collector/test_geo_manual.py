#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Тесты ручных правок мест (geo.Manual, geo-manual.csv) и подозрительных пар (places.suspicious).

    python tools/collector/test_geo_manual.py
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import geo  # noqa: E402
import places  # noqa: E402

CSV = """название;регион;широта;долгота;примечание
Широкое;Днепропетровская область;47,686;33,264;село у Кривого Рога
Гулево;ДНР;48.372, 36.972;;из Яндекс Карт
Бузово;;;;проверено
# Комментарий;;1;2
"""


class Manual(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        path = Path(self.dir.name) / geo.MANUAL_NAME
        path.write_text(CSV, encoding="utf-8-sig")
        self.m = geo.Manual(path)

    def tearDown(self):
        self.dir.cleanup()

    def test_coords(self):
        self.assertEqual(self.m.get("Широкое", "Днепропетровская область"), [47.686, 33.264])
        self.assertIsNone(self.m.get("Широкое", "Херсонская область"), "другой регион — не та точка")
        self.assertEqual(self.m.get("Гулево", "Донецкая Народная Республика"), [48.372, 36.972], "ДНР = Донецкая область")

    def test_checked(self):
        self.assertTrue(self.m.checked("Бузово", "Киевская область"), "без региона — для любого")
        self.assertIsNone(self.m.get("Бузово", "Киевская область"), "без координат — только «проверено»")
        self.assertFalse(self.m.checked("Комментарий", ""))
        self.assertEqual(len(self.m.points), 3)

    def test_geocoder_step0(self):
        cache = geo.GeoCache(Path(self.dir.name) / "geocache.json")
        p = geo.Geocoder(cache).resolve({"name": "Широкое", "kind": "settlement", "region": "Днепропетровская область",
                                         "lat": 48.0, "lon": 34.0})
        self.assertEqual((p["lat"], p["lon"], p["_src"]), (47.686, 33.264, "manual"))

    def test_missing_file(self):
        m = geo.Manual(Path(self.dir.name) / "нет.csv")
        self.assertEqual((m.points, m.checked("Широкое", "")), ({}, False))


class Suspicious(unittest.TestCase):
    ROWS = [("a", "Широкое", "settlement", "Украина", "Днепропетровская область", 47.7, 33.3, "1"),
            ("b", "Широкое", "settlement", "Украина", "Херсонская область", 46.8, 32.9, "2")]

    def test_pair(self):
        self.assertEqual(len(places.suspicious(self.ROWS)), 1)

    def test_one_checked(self):
        self.assertEqual(len(places.suspicious([self.ROWS[0] + (True,), self.ROWS[1] + (False,)])), 1)

    def test_both_checked(self):
        self.assertEqual(places.suspicious([r + (True,) for r in self.ROWS]), [])


if __name__ == "__main__":
    unittest.main()
