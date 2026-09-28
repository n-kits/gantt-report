#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Самопроверка сборщика без Bitrix: Playwright + Edge открывают обезличенную
страницу tests/fixtures/bitrix-tasks.html, разбирают её тем же кодом, что и
на живой странице, шифруют паролем «test» и пишут tests/fixtures/live-sample.json.

Сайт проверяет расшифровку этого файла: index.html?data=tests/fixtures/live-sample.json
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect  # noqa: E402

from playwright.sync_api import sync_playwright  # noqa: E402

FIXTURE = collect.REPO_ROOT / "tests" / "fixtures" / "bitrix-tasks.html"
OUT = collect.REPO_ROOT / "tests" / "fixtures" / "live-sample.json"


def main() -> int:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page()
        page.goto(FIXTURE.as_uri())
        res = collect.parse_page(page)
        browser.close()
    assert res["count"] == 25, res["count"]
    assert res["now"] == "28.09.2026 22:32:45", res["now"]
    payload = {"rows": res["rows"], "now": res["now"], "range": {"from": "26.09.2026 04:00", "to": "28.09.2026 22:32"},
               "sourceName": "Bitrix · тестовые данные"}
    envelope = {
        "v": 1, "generatedAt": "2026-09-28T19:32:45Z", "intervalMin": 60, "source": payload["sourceName"],
        "status": "ok", "message": "", "count": res["count"], "range": payload["range"], "bitrixNow": res["now"],
        "dataAt": "2026-09-28T19:32:45Z", "enc": collect.encrypt(payload, "test", 1000),
    }
    OUT.write_text(json.dumps(envelope, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"OK: {res['count']} задач, колонки {res['columns']}, записано {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
