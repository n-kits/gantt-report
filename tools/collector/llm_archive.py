#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Дообработка архива через LLM — заказы, догруженные --backfill (в архиве только строки ленты),
и A/B-тест вариантов запроса: A — закрытый список регионов, B — регион свободной строкой;
в обоих часовой кэш промпта.

    python tools/collector/llm_archive.py fetch                 # описания задач без анализа: Bitrix → очистка → архив
    python tools/collector/llm_archive.py test [--n 80]         # A/B на выборке → in/llm-test.html (в архив не пишет)
    python tools/collector/llm_archive.py apply --variant A|B   # разобрать остальное выбранным вариантом → архив

Тест геокодирует каждый вариант на своей копии кэша координат — варианты не дают друг другу фору.
Плановые запуски сборщика не мешают: Bitrix и запись в кэш/архив — под общей блокировкой, LLM — без неё.
"""
from __future__ import annotations

import argparse
import html
import json
import logging
import shutil
import sys
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import archive  # noqa: E402
import collect  # noqa: E402
import geo  # noqa: E402
import places  # noqa: E402
import scrub  # noqa: E402

log = logging.getLogger("collector")
STATE = collect.APP_DIR / "llm-archive.json"            # какие описания уже скачаны, результаты теста
REPORT = collect.REPO_ROOT / "in" / "llm-test.html"
# цены Claude Sonnet 5.5, $ за 1 млн токенов: вход, выход, запись в кэш на 1 ч (2×), чтение из кэша
PRICE = {"input": 2.0, "output": 10.0, "cache_write": 4.0, "cache_read": 0.2}


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"fetched": [], "test": {}}


def save_state(st: dict) -> None:
    STATE.write_text(json.dumps(st, ensure_ascii=False, indent=1), encoding="utf-8")


@contextmanager
def wait_lock():
    """Общая блокировка со сборщиком; занята плановым запуском — ждём."""
    while True:
        try:
            with collect.Lock() as lock:
                yield lock
            return
        except collect.CollectError as e:
            if e.code != "BUSY":
                raise
            log.info("Идёт плановый запуск сборщика — жду")
            time.sleep(20)


def todo(db) -> list[dict]:
    """Задачи архива без анализа LLM, по времени регистрации."""
    rows = db.execute("""SELECT id, name, url, description, day, start FROM tasks t
                         WHERE NOT EXISTS (SELECT 1 FROM analysis a WHERE a.task_id = t.id)""").fetchall()
    out = [{"id": r[0], "name": r[1], "url": r[2], "text": r[3] or "", "day": r[4], "start": r[5]} for r in rows]
    return sorted(out, key=lambda t: (archive.parse_dt(t["start"]) or datetime.min, t["id"]))


# ---------------------------------------------------------------------------
# 1. Описания
# ---------------------------------------------------------------------------

def fetch(cfg: dict) -> int:
    from playwright.sync_api import sync_playwright
    st = load_state()
    done = set(st["fetched"])
    db = archive.connect(collect.APP_DIR / "archive.sqlite")
    rows = [t for t in todo(db) if t["id"] not in done and not t["text"]]
    log.info("Описаний скачать: %s", len(rows))
    got = empty = 0
    with wait_lock() as lock, sync_playwright() as pw:
        ctx = collect.open_context(pw, headless=True)
        try:
            for i, t in enumerate(rows):
                if not t["url"]:
                    continue
                r = ctx.request.get(urljoin(cfg["tasks_url"], t["url"]), timeout=60_000)
                if not r.ok:
                    log.warning("Задача %s: HTTP %s", t["id"], r.status)
                    continue
                page = r.body().decode("utf-8", "replace")
                if 'name="form_auth"' in page:          # форма входа вместо задачи
                    raise collect.CollectError("LOGIN_REQUIRED", "Bitrix просит войти — collect.py --login")
                text = scrub.clean(geo.extract_description(page))
                with db:
                    db.execute("UPDATE tasks SET description = ? WHERE id = ?", (text or None, t["id"]))
                got += bool(text)
                empty += not text
                st["fetched"].append(t["id"])
                if i % 20 == 19:
                    save_state(st)
                    lock.touch()
                    log.info("Скачано %s из %s", i + 1, len(rows))
                time.sleep(0.4)                       # не нагружаем Bitrix
        finally:
            ctx.close()
            save_state(st)
            db.close()
    log.info("Описания: с текстом %s, без описания %s (анализ по названию)", got, empty)
    return 0


# ---------------------------------------------------------------------------
# 2. Тест
# ---------------------------------------------------------------------------

def geocode(results: dict, cache_path: Path) -> dict:
    """Результаты LLM → топонимы для карты на своей копии кэша; счётчики источников и запросов Nominatim."""
    cache = geo.GeoCache(cache_path)
    coder = geo.Geocoder(cache)
    calls = {"n": 0}
    orig = coder._nominatim

    def counted(q):
        calls["n"] += 1
        return orig(q)
    coder._nominatim = counted
    tops, src = {}, {}
    for tid, r in results.items():
        tops[tid] = [p for p in (geo.published(x, coder.resolve(x)) for x in r.get("toponyms", [])) if p]
        for p in tops[tid]:
            src[p["src"]] = src.get(p["src"], 0) + 1
    cache.save()
    return {"tops": tops, "src": src, "nominatim": calls["n"]}


def cost(usage: list[dict]) -> dict:
    tot = {k: sum(u[k] for u in usage) for k in ("input", "output", "cache_write", "cache_read")}
    tot["usd"] = round(sum(tot[k] * PRICE[k] for k in PRICE) / 1e6, 4)
    tot["requests"] = len(usage)
    return tot


def jaccard(a: set, b: set) -> float:
    return 1.0 if not a and not b else len(a & b) / len(a | b)


def compare(x: dict, y: dict, ids: list[str]) -> dict:
    """Согласие двух прогонов по общим задачам: названия, идентификаторы мест, полностью совпавшие задачи."""
    names, pids, same = [], [], 0
    for tid in ids:
        a, b = x["tops"].get(tid, []), y["tops"].get(tid, [])
        na, nb = {places.norm(p["name"]) for p in a}, {places.norm(p["name"]) for p in b}
        pa, pb = {p["pid"] for p in a}, {p["pid"] for p in b}
        names.append(jaccard(na, nb))
        pids.append(jaccard(pa, pb))
        same += pa == pb
    n = max(1, len(ids))
    return {"names": sum(names) / n, "pids": sum(pids) / n, "same": same, "n": len(ids)}


def test(cfg: dict, n: int, noise: int) -> int:
    st = load_state()
    db = archive.connect(collect.APP_DIR / "archive.sqlite")
    pool = [t for t in todo(db) if t["id"] in set(st["fetched"])]
    db.close()
    if not pool:
        sys.exit("Нет задач со скачанными описаниями — сначала: llm_archive.py fetch")
    step = max(1, len(pool) // n)
    sample = pool[::step][:n]                     # равномерно по времени
    tasks = [{"id": t["id"], "name": t["name"], "text": t["text"]} for t in sample]
    ids = [t["id"] for t in tasks]
    log.info("Тест: выборка %s задач из %s, контроль шума — %s", len(tasks), len(pool), noise)

    runs = {}
    for key, region_list, part in (("A", True, tasks), ("B", False, tasks), ("A2", True, tasks[:noise])):
        usage: list = []
        t0 = time.time()
        res = geo.analyze(part, cfg, region_list=region_list, cache_ttl="1h", usage=usage)
        runs[key] = {"results": res, "usage": usage, "seconds": round(time.time() - t0)}
        log.info("%s: задач с ответом %s из %s, %s", key, len(res), len(part), cost(usage))

    tmp = Path(tempfile.mkdtemp(prefix="llm-test-"))
    real = collect.APP_DIR / "geocache.json"
    for key in runs:
        shutil.copy(real, tmp / f"{key}.json")
        runs[key].update(geocode(runs[key]["results"], tmp / f"{key}.json"))
        log.info("%s: геокодирование %s, запросов Nominatim %s", key, runs[key]["src"], runs[key]["nominatim"])

    enum = set(places.region_enum())
    free = [x.get("region", "") for r in runs["B"]["results"].values() for x in r["toponyms"] if x.get("region")]
    report = {
        "at": datetime.now().isoformat(timespec="seconds"), "model": cfg.get("llm_model"), "n": len(tasks),
        "noise": noise, "ids": ids,
        "cost": {k: cost(v["usage"]) for k, v in runs.items()},
        "usage": {k: v["usage"] for k, v in runs.items()},
        "seconds": {k: v["seconds"] for k, v in runs.items()},
        "geo": {k: {"src": v["src"], "nominatim": v["nominatim"],
                    "toponyms": sum(len(t) for t in v["tops"].values())} for k, v in runs.items()},
        "AB": compare(runs["A"], runs["B"], ids),
        "AA2": compare(runs["A"], runs["A2"], ids[:noise]),
        "BA2": compare(runs["B"], runs["A2"], ids[:noise]),
        "free_regions": {"total": len(free), "outside_list": sorted({r for r in free if r not in enum})},
        "diff": [{"id": tid, "A": sorted({p["name"] for p in runs["A"]["tops"].get(tid, [])}),
                  "B": sorted({p["name"] for p in runs["B"]["tops"].get(tid, [])})}
                 for tid in ids if {p["pid"] for p in runs["A"]["tops"].get(tid, [])} != {p["pid"] for p in runs["B"]["tops"].get(tid, [])}],
    }
    st["test"] = {"report": report, "results": {k: runs[k]["results"] for k in ("A", "B")}}
    save_state(st)
    write_report(report)
    print(f"Отчёт: {REPORT}")
    return 0


def write_report(r: dict) -> None:
    e = html.escape
    c, g = r["cost"], r["geo"]
    # постоянная часть запроса (инструкция + схема) — по первому запросу каждого варианта
    prefix = {k: (r["usage"][k][0]["cache_write"] + r["usage"][k][0]["cache_read"]) if r["usage"][k] else 0 for k in ("A", "B")}
    per_task_in = {k: (c[k]["input"] / max(1, r["n"] if k != "A2" else r["noise"])) for k in ("A", "B")}
    out_per_task = {k: c[k]["output"] / max(1, r["n"]) for k in ("A", "B")}

    def regular(k, hit):
        """$ за запрос с 1 заказом в обычном режиме: попадание в часовой кэш с вероятностью hit."""
        p = prefix[k]
        fixed = hit * p * PRICE["cache_read"] + (1 - hit) * p * PRICE["cache_write"]
        return (fixed + per_task_in[k] * PRICE["input"] + out_per_task[k] * PRICE["output"]) / 1e6

    def nocache(k):
        return (prefix[k] * PRICE["input"] + per_task_in[k] * PRICE["input"] + out_per_task[k] * PRICE["output"]) / 1e6

    rows = "".join(
        f"<tr><td>{k}</td><td>{c[k]['requests']}</td><td>{c[k]['input']:,}</td><td>{c[k]['cache_write']:,}</td>"
        f"<td>{c[k]['cache_read']:,}</td><td>{c[k]['output']:,}</td><td><b>${c[k]['usd']:.3f}</b></td>"
        f"<td>{r['seconds'][k]} с</td><td>{g[k]['toponyms']}</td>"
        f"<td>{', '.join(f'{s}: {v}' for s, v in sorted(g[k]['src'].items()))}</td><td>{g[k]['nominatim']}</td></tr>"
        for k in ("A", "B", "A2"))
    agree = "".join(f"<tr><td>{e(label)}</td><td>{x['n']}</td><td>{x['names']:.0%}</td><td>{x['pids']:.0%}</td><td>{x['same']}</td></tr>"
                    for label, x in (("A ↔ B (эффект списка + шум)", r["AB"]), ("A ↔ A2 (шум: тот же вариант дважды)", r["AA2"]),
                                     ("B ↔ A2", r["BA2"])))
    reg = "".join(f"<tr><td>{k}</td><td>{prefix[k]:,}</td><td>${nocache(k):.4f}</td>"
                  + "".join(f"<td>${regular(k, h):.4f}</td>" for h in (0.0, 0.5, 0.8)) + "</tr>" for k in ("A", "B"))
    diff = "".join(f"<tr><td>{e(d['id'])}</td><td>{e(', '.join(d['A']))}</td><td>{e(', '.join(d['B']))}</td></tr>" for d in r["diff"])
    outside = ", ".join(e(x) for x in r["free_regions"]["outside_list"]) or "—"
    REPORT.write_text(f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Тест LLM: список регионов</title>
<style>body{{font-family:system-ui,"Segoe UI",sans-serif;margin:16px;color:#1f2937}} table{{border-collapse:collapse;margin:6px 0 18px}}
th,td{{border:1px solid #d4cfc4;padding:4px 8px;text-align:left;vertical-align:top;font-size:13px}} th{{background:#0f2c3a;color:#fff}}
td:nth-child(n+2){{font-variant-numeric:tabular-nums}} .sub{{color:#6b7280;font-size:13px}} h2{{font-size:16px;margin:18px 0 4px}}</style></head><body>
<h1 style="font-size:20px;margin:0">A/B: закрытый список регионов (A) или свободная строка (B), часовой кэш в обоих</h1>
<p class="sub">{e(r['at'])} · модель {e(r['model'] or '')} · выборка {r['n']} архивных задач, контроль шума — {r['noise']} задач (A2 = A ещё раз).
Цены Sonnet 5.5: вход $2, выход $10, запись в кэш на 1 ч $4, чтение $0,2 за 1 млн токенов. Геокодирование — на копии кэша для каждого прогона.</p>
<h2>Расход и геокодирование</h2>
<table><tr><th>Прогон</th><th>Запросов</th><th>Вход без кэша</th><th>Запись в кэш</th><th>Чтение из кэша</th><th>Выход</th><th>Стоимость</th>
<th>Время</th><th>Топонимов</th><th>Источник координат</th><th>Запросов Nominatim</th></tr>{rows}</table>
<h2>Согласие результатов</h2>
<p class="sub">Сходство наборов по задаче (пересечение / объединение), в среднем; «совпали полностью» — одинаковый набор мест.
Если A↔B не хуже A↔A2, разница между вариантами — в пределах шума.</p>
<table><tr><th>Сравнение</th><th>Задач</th><th>Названия</th><th>Места (pid)</th><th>Совпали полностью</th></tr>{agree}</table>
<h2>Обычный режим: оценка на запрос с 1 заказом</h2>
<p class="sub">Модель по измеренным токенам: постоянная часть (инструкция + схема) — запись в кэш при промахе, чтение при попадании.
В тесте пакеты шли подряд, поэтому попадания почти всегда; при запросе раз в 15+ минут часть записей сгорает.</p>
<table><tr><th>Вариант</th><th>Постоянная часть, ток.</th><th>Без кэша</th><th>Кэш, попаданий 0%</th><th>50%</th><th>80%</th></tr>{reg}</table>
<h2>Регионы в варианте B (свободная строка)</h2>
<p class="sub">Всего указано {r['free_regions']['total']}; не совпадают со списком: {outside}</p>
<h2>Задачи, где наборы мест A и B различаются ({len(r['diff'])})</h2>
<table><tr><th>ID</th><th>A</th><th>B</th></tr>{diff}</table>
</body></html>""", encoding="utf-8")


# ---------------------------------------------------------------------------
# 3. Применение
# ---------------------------------------------------------------------------

def apply(cfg: dict, variant: str, chunk: int) -> int:
    st = load_state()
    reuse = (st.get("test") or {}).get("results", {}).get(variant, {})
    db = archive.connect(collect.APP_DIR / "archive.sqlite")
    pool = [t for t in todo(db) if t["id"] in set(st["fetched"])]
    log.info("Разобрать: %s задач, из теста берём %s", len(pool), len([t for t in pool if t["id"] in reuse]))
    usage: list = []
    days = set()
    model = cfg.get("llm_model")
    for i in range(0, len(pool), chunk):
        part = pool[i:i + chunk]
        results = {t["id"]: reuse[t["id"]] for t in part if t["id"] in reuse}
        need = [{"id": t["id"], "name": t["name"], "text": t["text"]} for t in part if t["id"] not in results]
        if need:
            results.update(geo.analyze(need, cfg, region_list=variant == "A", cache_ttl="1h", usage=usage))
        with wait_lock():                         # кэш координат и архив пишет и сборщик
            cache = geo.GeoCache(collect.APP_DIR / "geocache.json")
            coder = geo.Geocoder(cache)
            items = []
            for t in part:
                r = results.get(t["id"])
                if not r:
                    continue
                tops = [p for p in (geo.published(x, coder.resolve(x)) for x in r.get("toponyms", [])) if p]
                items.append({"id": t["id"], "themes": r.get("themes", []), "conflict": r.get("conflict", ""),
                              "sentiment": r.get("sentiment", ""), "model": model, "toponyms": tops})
                days.add(t["day"])
            cache.save()
            with db:
                archive.save_analysis(db, items)
        log.info("Разобрано %s из %s, расход пока %s", min(i + chunk, len(pool)), len(pool), cost(usage))
    exported = {d for (d,) in db.execute("SELECT day FROM exports")}
    for d in sorted(days & exported):             # в Excel — темы и топонимы
        archive.export_day(db, cfg, d, archive.archive_dir(cfg))
    db.close()
    log.info("Готово: %s", cost(usage))
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Дообработка архива через LLM")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("fetch")
    t = sub.add_parser("test")
    t.add_argument("--n", type=int, default=80)
    t.add_argument("--noise", type=int, default=16)
    a = sub.add_parser("apply")
    a.add_argument("--variant", choices=["A", "B"], required=True)
    a.add_argument("--chunk", type=int, default=40)
    args = p.parse_args()
    collect.setup_logging(True)
    cfg = collect.load_config()
    if args.cmd == "fetch":
        return fetch(cfg)
    if args.cmd == "test":
        return test(cfg, args.n, args.noise)
    return apply(cfg, args.variant, args.chunk)


if __name__ == "__main__":
    raise SystemExit(main())
