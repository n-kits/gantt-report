#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Регулярный отчёт: анализ задач + диаграмма Ганта.

Ожидаемые колонки выгрузки (порядок и пробелы не важны):
  Название, Проект, Регистрация, Исполнитель, Виды работ,
  Завершение, Статус, Крайний срок, Вид продукции

Примеры:

  python3 gantt_report.py выгрузка.xlsx
  python3 gantt_report.py выгрузка.xlsx -o отчёт.xlsx
  python3 gantt_report.py ./inbox --latest
  python3 gantt_report.py выгрузка.xlsx --now "2026-09-15 10:56"
  python3 gantt_report.py выгрузка.xlsx --day-start 7 --no-image

Зависимости: openpyxl, matplotlib
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

import openpyxl
from openpyxl import Workbook
from openpyxl.chart import BarChart, PieChart, Reference
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.series import DataPoint
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

# ---------------------------------------------------------------------------
# Настройки по умолчанию — менять здесь, если процесс стабильный
# ---------------------------------------------------------------------------
DEFAULT_DAY_START_HOUR = 4
MAX_TIMELINE_COLS = 72
STATUS_DONE = "Завершена"
STATUS_REVIEW = "На рассмотрении"
STATUS_RUN = "Выполняется"

COL_ALIASES = {
    "name": ("название", "задача", "наименование"),
    "project": ("проект",),
    "start": ("регистрация", "создана", "старт", "начало"),
    "executor": ("исполнитель", "ответственный"),
    "works": ("виды работ", "работы", "вид работ"),
    "finish": ("завершение", "финиш", "окончание", "закрыта"),
    "status": ("статус", "состояние"),
    "deadline": ("крайний срок", "дедлайн", "срок"),
    "product": ("вид продукции", "продукция", "тип"),
}

C = {
    "navy": "1B3A4B",
    "header": "0F2C3A",
    "teal": "1A6B6B",
    "accent": "C45C26",
    "white": "FFFFFF",
    "line": "D4CFC4",
    "green": "2E7D4F",
    "green_bg": "D8EDE0",
    "orange": "C47A16",
    "orange_bg": "F8E6C8",
    "blue": "2B6CB0",
    "blue_bg": "D6E6F5",
    "red": "B42318",
    "red_bg": "F8D7D3",
    "gray": "6B7280",
    "gray_bg": "EEECE6",
    "gold": "C9A227",
    "light": "FAF8F3",
    "alt": "F0EBE1",
}

PROJ_COLOR = {
    "Погода (Р24)": "2B6CB0",
    "Экономика (Р24)": "2E7D4F",
    "Вести (Р24)": "7C3AED",
    "В23_(ПРАЙМ) (Р24)": "B42318",
    "Факты (Р24)": "C47A16",
    "Инфографика (Р24)": "0F766E",
}
STATUS_COLOR = {
    STATUS_DONE: C["green"],
    STATUS_REVIEW: C["orange"],
    STATUS_RUN: C["blue"],
}
STATUS_BG = {
    STATUS_DONE: C["green_bg"],
    STATUS_REVIEW: C["orange_bg"],
    STATUS_RUN: C["blue_bg"],
}
EXEC_PALETTE = ["1D4E89", "0F766E", "9A3412", "7C3AED", "BE185D", "365314", "0E7490", "92400E"]


def norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def parse_dt(v):
    if v is None or str(v).strip() == "":
        return None
    if isinstance(v, datetime):
        return v
    s = str(v).strip()
    for fmt in (
        "%d.%m.%y %H:%M:%S",
        "%d.%m.%Y %H:%M:%S",
        "%d.%m.%y %H:%M",
        "%d.%m.%Y %H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%d.%m.%y",
        "%d.%m.%Y",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def parse_now_arg(s: str) -> datetime:
    dt = parse_dt(s)
    if dt is None:
        raise argparse.ArgumentTypeError(f"не разобрал дату: {s}")
    return dt


def extract_id(name: str) -> str:
    if not name:
        return ""
    parts = str(name).split("#")
    return parts[-1].strip() if len(parts) > 1 else ""


def short_name(name: str, maxlen: int = 62) -> str:
    if not name:
        return ""
    s = str(name)
    if "#" in s:
        s = s.rsplit("#", 1)[0].strip()
    if ":" in s and "(Р24)" in s.split(":")[0]:
        s = s.split(":", 1)[1].strip()
    for junk in ("Карта_плазма_", "Карта СВО плазма_", "Стандартная карта на плазму_", "_карта сво_", " в растр"):
        s = s.replace(junk, "")
    if len(s) > maxlen:
        s = s[: maxlen - 1] + "…"
    return s


def map_columns(header_row) -> dict:
    idx = {}
    for i, raw in enumerate(header_row):
        h = norm(raw)
        for key, aliases in COL_ALIASES.items():
            if any(h == a or h.startswith(a) for a in aliases):
                idx.setdefault(key, i)
    required = ("name", "start")
    missing = [k for k in required if k not in idx]
    if missing:
        raise ValueError(
            "Не нашёл обязательные колонки: "
            + ", ".join(missing)
            + f". Заголовки файла: {[str(x).strip() if x else '' for x in header_row]}"
        )
    return idx


def guess_now_from_filename(path: Path) -> datetime | None:
    m = re.search(r"(20\d{2})[_-](\d{2})[_-](\d{2})[_-](\d{2})[_-](\d{2})[_-](\d{2})", path.name)
    if m:
        y, mo, d, h, mi, s = map(int, m.groups())
        try:
            return datetime(y, mo, d, h, mi, s)
        except ValueError:
            return None
    return None


def find_latest_xlsx(folder: Path) -> Path:
    files = [p for p in folder.glob("*.xlsx") if not p.name.startswith("~$") and not p.name.startswith("Диаграмма_Ганта")]
    if not files:
        files = [p for p in folder.glob("*.xlsx") if not p.name.startswith("~$")]
    if not files:
        raise FileNotFoundError(f"В {folder} нет .xlsx")
    return max(files, key=lambda p: p.stat().st_mtime)


def load_tasks(src: Path, now: datetime) -> list[dict]:
    wb = openpyxl.load_workbook(src, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        raise ValueError("Пустой лист")
    col = map_columns(rows[0])

    tasks = []
    for raw in rows[1:]:
        if raw is None or all(c is None or str(c).strip() == "" for c in raw):
            continue
        def get(key):
            i = col.get(key)
            return raw[i] if i is not None and i < len(raw) else None

        name = str(get("name") or "").strip()
        if not name:
            continue
        start = parse_dt(get("start"))
        finish = parse_dt(get("finish"))
        deadline = parse_dt(get("deadline"))
        status = str(get("status") or "").strip()
        actual_end = finish if finish else now
        duration_h = (actual_end - start).total_seconds() / 3600.0 if start else 0.0
        delay_h = None
        late = False
        if deadline and actual_end:
            delay_h = (actual_end - deadline).total_seconds() / 3600.0
            if status == STATUS_RUN:
                late = now > deadline
                delay_h = (now - deadline).total_seconds() / 3600.0
            else:
                late = delay_h > 0
        tasks.append({
            "id": extract_id(name),
            "name": name,
            "short": short_name(name),
            "project": str(get("project") or "").strip(),
            "start": start,
            "finish": finish,
            "actual_end": actual_end,
            "executor": str(get("executor") or "").strip() or "—",
            "works": str(get("works") or ""),
            "status": status or "—",
            "deadline": deadline,
            "product": str(get("product") or "").strip() or "—",
            "duration_h": duration_h,
            "late": late,
            "delay_h": delay_h,
        })
    tasks.sort(key=lambda t: (t["start"] or now, t["id"]))
    if not tasks:
        raise ValueError("Не удалось прочитать ни одной задачи")
    return tasks


def infer_window(tasks, now: datetime, day_start_hour: int):
    starts = [t["start"] for t in tasks if t["start"]]
    ends = [t["actual_end"] for t in tasks if t["actual_end"]]
    if not starts:
        raise ValueError("Нет ни одной даты регистрации")
    first = min(starts)
    last = max(ends + [now])
    base = first.replace(minute=0, second=0, microsecond=0)
    if day_start_hour is not None:
        cand = first.replace(hour=day_start_hour, minute=0, second=0, microsecond=0)
        if cand <= first:
            base = cand
        else:
            base = cand - timedelta(days=1)
    end = last.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    span_h = max(1, int((end - base).total_seconds() // 3600))
    step = 1
    if span_h > MAX_TIMELINE_COLS:
        step = 1
    if span_h / step > MAX_TIMELINE_COLS:
        step = 1
    if span_h / step > MAX_TIMELINE_COLS:
        step = 1
    n_slots = int((end - base).total_seconds() // 3600 // step)
    n_slots = max(8, min(MAX_TIMELINE_COLS, n_slots + 1))
    return base, end, step, n_slots


def hours_from(base: datetime, dt):
    if dt is None:
        return None
    return (dt - base).total_seconds() / 3600.0


def exec_color_map(tasks) -> dict:
    names = []
    for t in tasks:
        if t["executor"] not in names:
            names.append(t["executor"])
    return {n: EXEC_PALETTE[i % len(EXEC_PALETTE)] for i, n in enumerate(names)}


def bar_color(t) -> str:
    if t["late"] and t["status"] == STATUS_RUN:
        return C["accent"]
    if t["late"] and t["status"] == STATUS_REVIEW:
        return "9A3412"
    if t["late"]:
        return C["red"]
    return STATUS_COLOR.get(t["status"], C["gray"])


def sla_label(t, now: datetime) -> str:
    if t["deadline"] is None:
        return "Без срока"
    if t["status"] == STATUS_RUN:
        return "В работе" if now <= t["deadline"] else "Просрочена"
    if t["finish"] and t["finish"] <= t["deadline"]:
        return "В срок"
    return "Нарушен"


def month_ru(dt: datetime) -> str:
    months = (
        "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря",
    )
    return f"{dt.day} {months[dt.month - 1]} {dt.year}"


def period_label(base: datetime, end: datetime) -> str:
    if base.date() == (end - timedelta(seconds=1)).date():
        return month_ru(base)
    a, b = base, end - timedelta(seconds=1)
    if a.year == b.year and a.month == b.month:
        return f"{a.day}–{b.day} {month_ru(a).split(' ', 1)[1]}"
    return f"{a.strftime('%d.%m.%Y')} – {b.strftime('%d.%m.%Y')}"


# ---------------------------------------------------------------------------
# Excel styles
# ---------------------------------------------------------------------------
thin = Border(
    left=Side(style="thin", color=C["line"]),
    right=Side(style="thin", color=C["line"]),
    top=Side(style="thin", color=C["line"]),
    bottom=Side(style="thin", color=C["line"]),
)
font_title = Font(name="Calibri", size=18, bold=True, color=C["white"])
font_sub = Font(name="Calibri", size=11, italic=True, color="D4CFC4")
font_h = Font(name="Calibri", size=10, bold=True, color=C["white"])
font_sec = Font(name="Calibri", size=13, bold=True, color=C["navy"])
font_n = Font(name="Calibri", size=10, color="1F2937")
font_b = Font(name="Calibri", size=10, bold=True, color="1F2937")
font_s = Font(name="Calibri", size=9, color="1F2937")
font_sm = Font(name="Calibri", size=8, color="374151")
font_w = Font(name="Calibri", size=9, bold=True, color=C["white"])
fill_header = PatternFill("solid", fgColor=C["header"])
fill_navy = PatternFill("solid", fgColor=C["navy"])
fill_light = PatternFill("solid", fgColor=C["light"])
fill_alt = PatternFill("solid", fgColor=C["alt"])
fill_white = PatternFill("solid", fgColor=C["white"])
center = Alignment(horizontal="center", vertical="center", wrap_text=True)
left = Alignment(horizontal="left", vertical="center", wrap_text=True)


def banner(ws, title, subtitle, cols):
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=cols)
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=cols)
    ws["A1"] = title
    ws["A1"].font = font_title
    ws["A1"].fill = fill_header
    ws["A1"].alignment = Alignment(horizontal="left", vertical="center")
    ws["A2"] = subtitle
    ws["A2"].font = font_sub
    ws["A2"].fill = fill_header
    ws["A2"].alignment = Alignment(horizontal="left", vertical="center")
    ws.row_dimensions[1].height = 26
    ws.row_dimensions[2].height = 16
    for c in range(1, cols + 1):
        ws.cell(1, c).fill = fill_header
        ws.cell(2, c).fill = fill_header


def header_row(ws, row, headers, start_col=1, fill=None):
    fill = fill or fill_navy
    for i, h in enumerate(headers):
        cell = ws.cell(row, start_col + i, h)
        cell.font = font_h
        cell.fill = fill
        cell.alignment = center
        cell.border = thin


def setup_sheet(ws, paper="A4", fit_h=1):
    ws.sheet_view.showGridLines = False
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = fit_h
    ws.page_setup.paperSize = ws.PAPERSIZE_A3 if paper == "A3" else ws.PAPERSIZE_A4
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.horizontalCentered = True
    ws.page_setup.leftMargin = 0.4
    ws.page_setup.rightMargin = 0.4
    ws.page_setup.topMargin = 0.45
    ws.page_setup.bottomMargin = 0.4
    ws.oddFooter.center.text = "Стр. &P из &N"


def write_summary(wb, tasks, meta, exec_colors):
    ws = wb.active
    ws.title = "Сводка"
    setup_sheet(ws, "A4", 1)
    banner(
        ws,
        "Анализ задач и диаграмма Ганта",
        f"{meta['source_name']} · {meta['period']} · выгрузка {meta['now'].strftime('%d.%m.%Y %H:%M')} · задач: {len(tasks)}",
        12,
    )

    n = len(tasks)
    n_done = sum(1 for t in tasks if t["status"] == STATUS_DONE)
    n_review = sum(1 for t in tasks if t["status"] == STATUS_REVIEW)
    n_run = sum(1 for t in tasks if t["status"] == STATUS_RUN)
    n_late = sum(1 for t in tasks if t["late"])
    durs = [t["duration_h"] for t in tasks if t["finish"]]
    avg_d = sum(durs) / len(durs) if durs else 0
    max_d = max(durs) if durs else 0
    min_d = min(durs) if durs else 0

    kpis = [
        ("A", "B", "Всего задач", str(n), C["navy"]),
        ("C", "D", "Завершено", f"{n_done}  ({n_done / n:.0%})" if n else "0", C["green"]),
        ("E", "F", "На рассмотрении", str(n_review), C["orange"]),
        ("G", "H", "Выполняется", str(n_run), C["blue"]),
        ("I", "J", "С нарушением срока", str(n_late), C["red"]),
        ("K", "L", "Средняя длительность", f"{avg_d:.1f} ч", C["teal"]),
    ]
    for c1, c2, label, val, color in kpis:
        a, b = ord(c1) - 64, ord(c2) - 64
        ws.merge_cells(start_row=4, start_column=a, end_row=4, end_column=b)
        ws.merge_cells(start_row=5, start_column=a, end_row=5, end_column=b)
        ws.cell(4, a, label).font = Font(name="Calibri", size=8, bold=True, color="E5E7EB")
        ws.cell(5, a, val).font = Font(name="Calibri", size=16, bold=True, color="FFFFFF")
        for r in (4, 5):
            for c in range(a, b + 1):
                ws.cell(r, c).fill = PatternFill("solid", fgColor=color)
                ws.cell(r, c).alignment = center
    ws.row_dimensions[4].height = 16
    ws.row_dimensions[5].height = 28

    ws.merge_cells("A7:E7")
    ws["A7"] = "Нагрузка по исполнителям"
    ws["A7"].font = font_sec
    header_row(ws, 8, ["Исполнитель", "Задач", "Завершено", "Ср. длит., ч", "Нарушений срока"])

    ex = defaultdict(lambda: {"n": 0, "done": 0, "dur": [], "late": 0})
    for t in tasks:
        e = t["executor"]
        ex[e]["n"] += 1
        if t["status"] == STATUS_DONE:
            ex[e]["done"] += 1
        if t["finish"]:
            ex[e]["dur"].append(t["duration_h"])
        if t["late"]:
            ex[e]["late"] += 1

    r = 9
    for name, d in sorted(ex.items(), key=lambda x: -x[1]["n"]):
        avg = sum(d["dur"]) / len(d["dur"]) if d["dur"] else 0
        vals = [name, d["n"], d["done"], round(avg, 2), d["late"]]
        for i, v in enumerate(vals, 1):
            cell = ws.cell(r, i, v)
            cell.font = font_n
            cell.alignment = center if i > 1 else left
            cell.border = thin
            cell.fill = fill_light if r % 2 == 0 else fill_white
            if i == 1:
                cell.font = Font(name="Calibri", size=10, bold=True, color=exec_colors.get(name, "1F2937"))
            if i == 5 and d["late"] > 0:
                cell.font = Font(name="Calibri", size=10, bold=True, color=C["red"])
                cell.fill = PatternFill("solid", fgColor=C["red_bg"])
        r += 1
    exec_end = r - 1
    ws.cell(r, 1, "Итого")
    ws.cell(r, 2, f"=SUM(B9:B{exec_end})")
    ws.cell(r, 3, f"=SUM(C9:C{exec_end})")
    ws.cell(r, 4, f"=AVERAGE(D9:D{exec_end})")
    ws.cell(r, 5, f"=SUM(E9:E{exec_end})")
    for i in range(1, 6):
        ws.cell(r, i).font = font_b
        ws.cell(r, i).fill = PatternFill("solid", fgColor="E8E4D9")
        ws.cell(r, i).alignment = center if i > 1 else left
        ws.cell(r, i).border = thin
    ws.cell(r, 4).number_format = "0.00"

    ws.merge_cells("G7:L7")
    ws["G7"] = "Распределение по проектам"
    ws["G7"].font = font_sec
    header_row(ws, 8, ["Проект", "Задач", "Доля", "Завершено", "Нарушений", "Ср. длит., ч"], start_col=7)

    pr = defaultdict(lambda: {"n": 0, "done": 0, "late": 0, "dur": []})
    for t in tasks:
        p = t["project"] or "—"
        pr[p]["n"] += 1
        if t["status"] == STATUS_DONE:
            pr[p]["done"] += 1
        if t["late"]:
            pr[p]["late"] += 1
        if t["finish"]:
            pr[p]["dur"].append(t["duration_h"])

    r = 9
    for name, d in sorted(pr.items(), key=lambda x: -x[1]["n"]):
        avg = sum(d["dur"]) / len(d["dur"]) if d["dur"] else 0
        ws.cell(r, 7, name)
        ws.cell(r, 8, d["n"])
        ws.cell(r, 10, d["done"])
        ws.cell(r, 11, d["late"])
        ws.cell(r, 12, round(avg, 2))
        for i in range(7, 13):
            cell = ws.cell(r, i)
            cell.font = font_n
            cell.alignment = center if i > 7 else left
            cell.border = thin
            cell.fill = fill_light if r % 2 == 0 else fill_white
            if i == 7:
                cell.font = Font(name="Calibri", size=10, bold=True, color=PROJ_COLOR.get(name, "1F2937"))
            if i == 11 and d["late"] > 0:
                cell.font = Font(name="Calibri", size=10, bold=True, color=C["red"])
                cell.fill = PatternFill("solid", fgColor=C["red_bg"])
            if i == 12:
                cell.number_format = "0.00"
        r += 1
    proj_end = r - 1
    ws.cell(r, 7, "Итого")
    ws.cell(r, 8, f"=SUM(H9:H{proj_end})")
    ws.cell(r, 9, 1)
    ws.cell(r, 10, f"=SUM(J9:J{proj_end})")
    ws.cell(r, 11, f"=SUM(K9:K{proj_end})")
    ws.cell(r, 12, f"=AVERAGE(L9:L{proj_end})")
    for i in range(7, 13):
        ws.cell(r, i).font = font_b
        ws.cell(r, i).fill = PatternFill("solid", fgColor="E8E4D9")
        ws.cell(r, i).alignment = center if i > 7 else left
        ws.cell(r, i).border = thin
    ws.cell(r, 9).number_format = "0%"
    ws.cell(r, 12).number_format = "0.00"
    total_proj = r
    for rr in range(9, proj_end + 1):
        ws.cell(rr, 9, f"=H{rr}/$H${total_proj}")
        ws.cell(rr, 9).number_format = "0%"

    ws.merge_cells("A16:E16")
    ws["A16"] = "По виду продукции"
    ws["A16"].font = font_sec
    header_row(ws, 17, ["Вид продукции", "Задач", "Доля", "Ср. длит., ч", "Нарушений"])

    pd = defaultdict(lambda: {"n": 0, "dur": [], "late": 0})
    for t in tasks:
        p = t["product"]
        pd[p]["n"] += 1
        if t["finish"]:
            pd[p]["dur"].append(t["duration_h"])
        if t["late"]:
            pd[p]["late"] += 1
    r = 18
    for name, d in sorted(pd.items(), key=lambda x: -x[1]["n"]):
        avg = sum(d["dur"]) / len(d["dur"]) if d["dur"] else 0
        ws.cell(r, 1, name)
        ws.cell(r, 2, d["n"])
        ws.cell(r, 4, round(avg, 2))
        ws.cell(r, 5, d["late"])
        for i in range(1, 6):
            cell = ws.cell(r, i)
            cell.font = font_n
            cell.alignment = center if i > 1 else left
            cell.border = thin
            cell.fill = fill_light if r % 2 == 0 else fill_white
        ws.cell(r, 4).number_format = "0.00"
        r += 1
    prod_end = r - 1
    ws.cell(r, 1, "Итого")
    ws.cell(r, 2, f"=SUM(B18:B{prod_end})")
    ws.cell(r, 3, 1)
    ws.cell(r, 4, f"=AVERAGE(D18:D{prod_end})")
    ws.cell(r, 5, f"=SUM(E18:E{prod_end})")
    for i in range(1, 6):
        ws.cell(r, i).font = font_b
        ws.cell(r, i).fill = PatternFill("solid", fgColor="E8E4D9")
        ws.cell(r, i).alignment = center if i > 1 else left
        ws.cell(r, i).border = thin
    ws.cell(r, 3).number_format = "0%"
    ws.cell(r, 4).number_format = "0.00"
    prod_total = r
    for rr in range(18, prod_end + 1):
        ws.cell(rr, 3, f"=B{rr}/$B${prod_total}")
        ws.cell(rr, 3).number_format = "0%"

    ws.merge_cells("G16:L16")
    ws["G16"] = "Задачи с нарушением крайнего срока"
    ws["G16"].font = Font(name="Calibri", size=13, bold=True, color=C["red"])
    header_row(ws, 17, ["ID", "Краткое название", "Исполнитель", "Срок", "Факт", "Опоздание, ч"], start_col=7, fill=PatternFill("solid", fgColor=C["red"]))

    late_tasks = sorted([t for t in tasks if t["late"]], key=lambda t: -(t["delay_h"] or 0))
    r = 18
    if not late_tasks:
        ws.merge_cells("G18:L18")
        ws["G18"] = "Нет задач с нарушением срока"
        late_end = 18
    else:
        for t in late_tasks:
            vals = [
                t["id"],
                t["short"],
                t["executor"],
                t["deadline"].strftime("%d.%m %H:%M") if t["deadline"] else "—",
                (t["finish"] or meta["now"]).strftime("%d.%m %H:%M"),
                round(t["delay_h"], 2) if t["delay_h"] is not None else None,
            ]
            for i, v in enumerate(vals, 7):
                cell = ws.cell(r, i, v)
                cell.font = font_s
                cell.alignment = center if i != 8 else left
                cell.border = thin
                cell.fill = PatternFill("solid", fgColor=C["red_bg"])
                if i == 12:
                    cell.number_format = "0.00"
            r += 1
        late_end = r - 1

    find_row = max(prod_total, late_end) + 2
    ws.merge_cells(start_row=find_row, start_column=1, end_row=find_row, end_column=12)
    ws.cell(find_row, 1, "Ключевые выводы").font = font_sec

    top_exec = max(ex.items(), key=lambda x: x[1]["n"]) if ex else ("—", {"n": 0})
    findings = [
        f"В выборке {n} задач: завершено {n_done}, на рассмотрении {n_review}, выполняется {n_run}.",
        f"Нарушение крайнего срока — у {n_late} задач."
        + (f" Лидер по числу задач — {top_exec[0]} ({top_exec[1]['n']})." if top_exec[0] != "—" else ""),
        f"Средняя фактическая длительность закрытых задач — {avg_d:.1f} ч"
        + (f" (мин. {min_d:.1f}, макс. {max_d:.1f})." if durs else "."),
        "Старт = «Регистрация». Финиш = «Завершение»; если пусто — момент расчёта отчёта. "
        "Нарушение срока = факт (или «сейчас») позже «Крайнего срока».",
    ]
    for i, text in enumerate(findings):
        rr = find_row + 1 + i
        ws.merge_cells(start_row=rr, start_column=1, end_row=rr, end_column=12)
        ws.cell(rr, 1, "•  " + text)
        ws.cell(rr, 1).font = font_n
        ws.cell(rr, 1).alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
        ws.row_dimensions[rr].height = 22
        ws.cell(rr, 1).fill = fill_light if i % 2 == 0 else fill_white

    note_row = find_row + 1 + len(findings) + 1
    ws.merge_cells(start_row=note_row, start_column=1, end_row=note_row, end_column=12)
    ws.cell(
        note_row, 1,
        f"Ось Ганта: {meta['base'].strftime('%d.%m.%Y %H:%M')} → {meta['end'].strftime('%d.%m.%Y %H:%M')}, "
        f"шаг ленты {meta['step']} ч. Скрипт: gantt_report.py.",
    )
    ws.cell(note_row, 1).font = Font(name="Calibri", size=8, italic=True, color=C["gray"])
    ws.cell(note_row, 1).alignment = Alignment(wrap_text=True, vertical="center")
    ws.row_dimensions[note_row].height = 22

    for col, w in {
        "A": 28, "B": 12, "C": 14, "D": 16, "E": 16, "F": 14,
        "G": 28, "H": 22, "I": 14, "J": 16, "K": 14, "L": 14,
    }.items():
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "A4"
    ws.print_area = f"A1:L{note_row}"
    return {"n": n, "n_done": n_done, "n_late": n_late, "avg_d": avg_d}


def write_tasks(wb, tasks, meta):
    wd = wb.create_sheet("Задачи")
    setup_sheet(wd, "A4", 0)
    banner(wd, "Нормализованный список задач", "Расчётные поля справа можно фильтровать", 14)
    headers = [
        "ID", "Краткое название", "Проект", "Исполнитель", "Вид продукции",
        "Статус", "Регистрация", "Завершение", "Крайний срок",
        "Длительность, ч", "Откл. от срока, ч", "Срок",
        "Старт, ч от начала оси", "Длит. для Ганта, ч",
    ]
    header_row(wd, 3, headers)
    wd.row_dimensions[3].height = 32
    wd.auto_filter.ref = f"A3:N{3 + len(tasks)}"
    wd.freeze_panes = "A4"

    for i, t in enumerate(tasks):
        r = 4 + i
        slack = None
        if t["deadline"] and t["actual_end"]:
            slack = (t["actual_end"] - t["deadline"]).total_seconds() / 3600.0
        sla = sla_label(t, meta["now"])
        vals = [
            t["id"], t["short"], t["project"], t["executor"], t["product"],
            t["status"], t["start"], t["finish"], t["deadline"],
            t["duration_h"], slack, sla,
            hours_from(meta["base"], t["start"]), t["duration_h"],
        ]
        for c, v in enumerate(vals, 1):
            cell = wd.cell(r, c, v)
            cell.font = font_s
            cell.alignment = center if c not in (2, 3, 5) else left
            cell.border = thin
            cell.fill = fill_alt if i % 2 else fill_white
            if c in (7, 8, 9) and v:
                cell.number_format = "DD.MM.YYYY HH:MM"
            if c in (10, 11, 13, 14) and v is not None:
                cell.number_format = "0.00"
            if c == 6:
                cell.fill = PatternFill("solid", fgColor=STATUS_BG.get(t["status"], C["gray_bg"]))
                cell.font = Font(name="Calibri", size=8, bold=True, color=STATUS_COLOR.get(t["status"], C["gray"]))
            if c == 12:
                if sla in ("Нарушен", "Просрочена"):
                    cell.fill = PatternFill("solid", fgColor=C["red_bg"])
                    cell.font = Font(name="Calibri", size=8, bold=True, color=C["red"])
                elif sla == "В срок":
                    cell.fill = PatternFill("solid", fgColor=C["green_bg"])
                    cell.font = Font(name="Calibri", size=8, bold=True, color=C["green"])
                elif sla == "В работе":
                    cell.fill = PatternFill("solid", fgColor=C["blue_bg"])
                    cell.font = Font(name="Calibri", size=8, bold=True, color=C["blue"])
            if c == 11 and slack is not None and slack > 0:
                cell.font = Font(name="Calibri", size=8, bold=True, color=C["red"])
        wd.row_dimensions[r].height = 18

    last = 3 + len(tasks)
    tr = last + 1
    wd.cell(tr, 1, "Итого / среднее")
    wd.cell(tr, 10, f"=AVERAGE(J4:J{last})")
    wd.cell(tr, 11, f"=AVERAGE(K4:K{last})")
    wd.cell(tr, 14, f"=SUM(N4:N{last})")
    for c in range(1, 15):
        wd.cell(tr, c).font = font_b
        wd.cell(tr, c).fill = PatternFill("solid", fgColor="E8E4D9")
        wd.cell(tr, c).border = thin
        wd.cell(tr, c).alignment = center
    wd.cell(tr, 10).number_format = "0.00"
    wd.cell(tr, 11).number_format = "0.00"
    wd.cell(tr, 14).number_format = "0.00"
    for col, w in {
        "A": 10, "B": 42, "C": 20, "D": 16, "E": 22, "F": 16,
        "G": 16, "H": 16, "I": 16, "J": 14, "K": 15, "L": 12,
        "M": 18, "N": 16,
    }.items():
        wd.column_dimensions[col].width = w
    wd.print_area = f"A1:N{tr}"
    wd.print_title_rows = "1:3"


def write_gantt_sheet(wb, tasks, meta, img_path: Path | None):
    wg = wb.create_sheet("Гант")
    setup_sheet(wg, "A3", 1)
    banner(
        wg,
        "Диаграмма Ганта",
        "Невидимый ряд «Смещение» задаёт старт; «Длительность» — фактическое выполнение. Ось X — часы от начала окна.",
        6,
    )
    header_row(wg, 3, ["Задача", "Исполнитель", "Статус", "Смещение, ч", "Длительность, ч", "Срок, ч от начала"])
    wg.row_dimensions[3].height = 28

    span = hours_from(meta["base"], meta["end"]) or 24
    for i, t in enumerate(tasks):
        r = 4 + i
        wg.cell(r, 1, f"#{t['id']}  {t['short']}" if t["id"] else t["short"])
        wg.cell(r, 2, t["executor"])
        wg.cell(r, 3, t["status"])
        wg.cell(r, 4, round(hours_from(meta["base"], t["start"]) or 0, 3))
        wg.cell(r, 5, round(t["duration_h"], 3))
        dl = hours_from(meta["base"], t["deadline"])
        wg.cell(r, 6, round(dl, 3) if dl is not None else None)
        for c in range(1, 7):
            cell = wg.cell(r, c)
            cell.font = font_sm
            cell.alignment = left if c == 1 else center
            cell.border = thin
            cell.fill = fill_alt if i % 2 else fill_white
            if c == 3:
                cell.fill = PatternFill("solid", fgColor=STATUS_BG.get(t["status"], C["gray_bg"]))
                cell.font = Font(name="Calibri", size=8, bold=True, color=STATUS_COLOR.get(t["status"], C["gray"]))
            if c in (4, 5, 6):
                cell.number_format = "0.00"
        wg.row_dimensions[r].height = 16

    g_last = 3 + len(tasks)
    chart = BarChart()
    chart.type = "bar"
    chart.grouping = "stacked"
    chart.title = f"Гант: регистрация → завершение (0 = {meta['base'].strftime('%d.%m %H:%M')})"
    chart.x_axis.title = f"Часы от {meta['base'].strftime('%d.%m.%Y %H:%M')}"
    chart.style = 10
    chart.y_axis.scaling.orientation = "maxMin"
    chart.x_axis.scaling.min = 0
    chart.x_axis.scaling.max = max(8, float(span))
    chart.x_axis.majorUnit = 2 if span <= 36 else 4
    chart.legend.position = "b"
    cats = Reference(wg, min_col=1, min_row=4, max_row=g_last)
    data = Reference(wg, min_col=4, min_row=3, max_col=5, max_row=g_last)
    chart.add_data(data, titles_from_data=True)
    chart.set_categories(cats)
    chart.shape = 4
    chart.overlap = 100
    chart.gapWidth = 40
    chart.series[0].graphicalProperties.noFill = True
    chart.series[0].graphicalProperties.line.noFill = True
    chart.series[1].graphicalProperties.solidFill = C["teal"]
    chart.series[1].graphicalProperties.line.noFill = True
    pts = []
    for i, t in enumerate(tasks):
        pt = DataPoint(idx=i)
        pt.graphicalProperties.solidFill = bar_color(t)
        pt.graphicalProperties.line.noFill = True
        pts.append(pt)
    chart.series[1].data_points = pts
    chart.width = 28
    chart.height = min(18, 6 + len(tasks) * 0.35)
    wg.add_chart(chart, "A34")

    wg.merge_cells("A32:F32")
    wg["A32"] = (
        "Цвета баров: зелёный — завершена в срок · красный — завершена с нарушением срока · "
        "оранжевый — на рассмотрении · синий — выполняется · тёмно-оранжевый — выполняется после срока."
    )
    wg["A32"].font = Font(name="Calibri", size=8, italic=True, color=C["gray"])
    wg["A32"].alignment = Alignment(wrap_text=True, vertical="center")
    wg.row_dimensions[32].height = 28

    for col, w in {"A": 62, "B": 16, "C": 16, "D": 14, "E": 16, "F": 18}.items():
        wg.column_dimensions[col].width = w
    wg.freeze_panes = "A4"

    img_row = 63
    if img_path and img_path.exists():
        wg.merge_cells("A63:F63")
        wg["A63"] = "Ниже — растровая диаграмма (для печати). Выше — живая Excel-диаграмма: бары зависят от столбцов D–E."
        wg["A63"].font = Font(name="Calibri", size=8, italic=True, color=C["gray"])
        img = XLImage(str(img_path))
        img.width = 1180
        img.height = int(1180 * 11.2 / 16.5)
        wg.add_image(img, "A64")
        img_row = 110
    wg.print_area = f"A1:F{img_row}"


def write_timeline(wb, tasks, meta, exec_colors):
    wt = wb.create_sheet("Лента времени")
    setup_sheet(wt, "A3", 1)
    base, step, n_slots = meta["base"], meta["step"], meta["n_slots"]
    hours = [base + timedelta(hours=i * step) for i in range(n_slots)]
    last_col = 4 + n_slots
    banner(
        wt,
        "Лента времени",
        f"Колонка = {step} ч. Заливка — задача шла в этом интервале. «◆» — крайний срок. "
        f"{base.strftime('%d.%m %H:%M')} → {(base + timedelta(hours=n_slots * step)).strftime('%d.%m %H:%M')}.",
        last_col,
    )
    header_row(wt, 4, ["ID", "Задача", "Исп.", "Статус"])
    wt.merge_cells("A3:D3")
    wt["A3"] = "Задача"
    wt["A3"].font = font_h
    wt["A3"].fill = fill_navy
    wt["A3"].alignment = center
    for c in range(1, 5):
        wt.cell(3, c).fill = fill_navy
        wt.cell(3, c).border = thin

    col0 = 5
    # date group headers
    groups = []
    for i, h in enumerate(hours):
        key = h.strftime("%d.%m.%Y")
        if not groups or groups[-1][0] != key:
            groups.append([key, i, i])
        else:
            groups[-1][2] = i
    palette_day = ["1D4E89", "9A3412", "0F766E", "6B21A8", "92400E"]
    for gi, (key, a, b) in enumerate(groups):
        color = palette_day[gi % len(palette_day)]
        wt.merge_cells(start_row=3, start_column=col0 + a, end_row=3, end_column=col0 + b)
        cell = wt.cell(3, col0 + a, key)
        cell.font = font_w
        cell.fill = PatternFill("solid", fgColor=color)
        cell.alignment = center
        for cc in range(col0 + a, col0 + b + 1):
            wt.cell(3, cc).fill = PatternFill("solid", fgColor=color)
            wt.cell(3, cc).border = thin
            wt.cell(3, cc).alignment = center

    for i, h in enumerate(hours):
        cell = wt.cell(4, col0 + i, h.strftime("%H"))
        cell.font = Font(name="Calibri", size=8, bold=True, color=C["white"])
        cell.fill = PatternFill("solid", fgColor="1B3A4B" if gi_day(h) % 2 == 0 else "7C2D12")
        cell.alignment = center
        cell.border = thin
    wt.row_dimensions[3].height = 18
    wt.row_dimensions[4].height = 16

    slot_sec = step * 3600
    for i, t in enumerate(tasks):
        r = 5 + i
        wt.cell(r, 1, t["id"]).font = Font(name="Calibri", size=8, bold=True, color=C["navy"])
        wt.cell(r, 2, t["short"]).font = font_sm
        short_ex = t["executor"].split()[0] if t["executor"] else "—"
        wt.cell(r, 3, short_ex).font = Font(name="Calibri", size=8, bold=True, color=exec_colors.get(t["executor"], "1F2937"))
        st = wt.cell(r, 4, t["status"])
        st.font = Font(name="Calibri", size=7, bold=True, color=STATUS_COLOR.get(t["status"], C["gray"]))
        st.fill = PatternFill("solid", fgColor=STATUS_BG.get(t["status"], C["gray_bg"]))
        for c in range(1, 5):
            wt.cell(r, c).alignment = left if c == 2 else center
            wt.cell(r, c).border = thin
            if c != 4:
                wt.cell(r, c).fill = fill_light

        start_idx = end_idx = None
        if t["start"] and t["actual_end"]:
            start_idx = int((t["start"] - base).total_seconds() // slot_sec)
            end_idx = int(((t["actual_end"] - base).total_seconds() - 1) // slot_sec)
            start_idx = max(0, min(n_slots - 1, start_idx))
            end_idx = max(0, min(n_slots - 1, end_idx))
        dl_idx = None
        if t["deadline"]:
            di = int((t["deadline"] - base).total_seconds() // slot_sec)
            if 0 <= di < n_slots:
                dl_idx = di
        fill_bar = PatternFill("solid", fgColor=bar_color(t))
        empty = PatternFill("solid", fgColor="F7F4EE")
        for h in range(n_slots):
            cell = wt.cell(r, col0 + h, "")
            cell.alignment = center
            cell.border = Border(
                left=Side(style="hair", color="E5E0D6"),
                right=Side(style="hair", color="E5E0D6"),
                top=Side(style="thin", color="E5E0D6"),
                bottom=Side(style="thin", color="E5E0D6"),
            )
            on = start_idx is not None and start_idx <= h <= end_idx
            cell.fill = fill_bar if on else empty
            if dl_idx is not None and h == dl_idx:
                cell.value = "◆"
                cell.font = Font(name="Calibri", size=8, bold=True, color="FFFFFF" if on else C["accent"])
                if not on:
                    cell.fill = PatternFill("solid", fgColor="F3E0C8")
        wt.row_dimensions[r].height = 16

    last_t = 4 + len(tasks)
    cap_row = last_t + 2
    wt.merge_cells(start_row=cap_row, start_column=1, end_row=cap_row, end_column=4)
    wt.cell(cap_row, 1, "Одновременно в работе")
    wt.cell(cap_row, 1).font = font_b
    wt.cell(cap_row, 1).alignment = Alignment(horizontal="right", vertical="center")
    for c in range(1, 5):
        wt.cell(cap_row, c).fill = PatternFill("solid", fgColor="E8E4D9")
        wt.cell(cap_row, c).border = thin

    for h in range(n_slots):
        hs = base + timedelta(hours=h * step)
        he = hs + timedelta(hours=step)
        cnt = sum(1 for t in tasks if t["start"] and t["actual_end"] and t["start"] < he and t["actual_end"] > hs)
        cell = wt.cell(cap_row, col0 + h, cnt)
        cell.alignment = center
        cell.font = Font(name="Calibri", size=8, bold=True, color=C["white"] if cnt >= 8 else C["navy"])
        cell.border = thin
        if cnt >= 12:
            cell.fill = PatternFill("solid", fgColor="7F1D1D")
        elif cnt >= 8:
            cell.fill = PatternFill("solid", fgColor="C2410C")
        elif cnt >= 5:
            cell.fill = PatternFill("solid", fgColor="CA8A04")
        elif cnt >= 3:
            cell.fill = PatternFill("solid", fgColor="A3B18A")
        else:
            cell.fill = PatternFill("solid", fgColor="E8E4D9")

    leg = cap_row + 2
    wt.merge_cells(start_row=leg, start_column=1, end_row=leg, end_column=min(12, last_col))
    wt.cell(leg, 1, "Легенда: цвет полосы = статус/срок. ◆ — интервал крайнего срока. Нижняя строка — пересечение задач.")
    wt.cell(leg, 1).font = Font(name="Calibri", size=8, italic=True, color=C["gray"])
    wt.row_dimensions[leg].height = 22

    wt.column_dimensions["A"].width = 10
    wt.column_dimensions["B"].width = 38
    wt.column_dimensions["C"].width = 12
    wt.column_dimensions["D"].width = 14
    for i in range(n_slots):
        wt.column_dimensions[get_column_letter(col0 + i)].width = 3.2 if step == 1 else 4.2
    wt.freeze_panes = "E5"
    wt.print_title_rows = "1:4"
    wt.print_title_cols = "A:D"
    wt.print_area = f"A1:{get_column_letter(last_col)}{leg}"


def gi_day(dt: datetime) -> int:
    return dt.toordinal()


def write_load(wb, tasks, exec_colors):
    we = wb.create_sheet("Нагрузка")
    setup_sheet(we, "A4", 1)
    banner(
        we,
        "Нагрузка исполнителей",
        "Сумма длительностей ≠ «чистые» часы: задачи одного человека могут пересекаться по времени.",
        9,
    )
    header_row(we, 4, ["Исполнитель", "Задач", "Сумма длительностей, ч", "Мин. длит., ч", "Макс. длит., ч", "Доля часов"])
    we.row_dimensions[4].height = 28

    ex = defaultdict(lambda: {"n": 0, "dur": []})
    for t in tasks:
        ex[t["executor"]]["n"] += 1
        if t["finish"] or t["duration_h"]:
            ex[t["executor"]]["dur"].append(t["duration_h"])

    r = 5
    for name, d in sorted(ex.items(), key=lambda x: -sum(x[1]["dur"])):
        durs = d["dur"]
        we.cell(r, 1, name)
        we.cell(r, 2, d["n"])
        we.cell(r, 3, round(sum(durs), 2) if durs else 0)
        we.cell(r, 4, round(min(durs), 2) if durs else 0)
        we.cell(r, 5, round(max(durs), 2) if durs else 0)
        for c in range(1, 7):
            cell = we.cell(r, c)
            cell.font = font_n
            cell.alignment = center if c > 1 else left
            cell.border = thin
            cell.fill = fill_white
            if c == 1:
                cell.font = Font(name="Calibri", size=11, bold=True, color=exec_colors.get(name, "1F2937"))
            if c in (3, 4, 5):
                cell.number_format = "0.00"
        r += 1
    ex_last = r - 1
    we.cell(r, 1, "Итого")
    we.cell(r, 2, f"=SUM(B5:B{ex_last})")
    we.cell(r, 3, f"=SUM(C5:C{ex_last})")
    we.cell(r, 4, f"=MIN(D5:D{ex_last})")
    we.cell(r, 5, f"=MAX(E5:E{ex_last})")
    we.cell(r, 6, 1)
    for c in range(1, 7):
        we.cell(r, c).font = font_b
        we.cell(r, c).fill = PatternFill("solid", fgColor="E8E4D9")
        we.cell(r, c).border = thin
        we.cell(r, c).alignment = center if c > 1 else left
    we.cell(r, 3).number_format = "0.00"
    we.cell(r, 4).number_format = "0.00"
    we.cell(r, 5).number_format = "0.00"
    we.cell(r, 6).number_format = "0%"
    tot = r
    for rr in range(5, ex_last + 1):
        we.cell(rr, 6, f"=C{rr}/$C${tot}")
        we.cell(rr, 6).number_format = "0%"

    ch2 = BarChart()
    ch2.type = "bar"
    ch2.style = 10
    ch2.title = "Сумма длительностей задач по исполнителям, ч"
    ch2.x_axis.title = "Часы"
    data = Reference(we, min_col=3, min_row=4, max_row=ex_last)
    cats = Reference(we, min_col=1, min_row=5, max_row=ex_last)
    ch2.add_data(data, titles_from_data=True)
    ch2.set_categories(cats)
    ch2.legend = None
    ch2.series[0].graphicalProperties.solidFill = C["teal"]
    ch2.width = 18
    ch2.height = 8
    we.add_chart(ch2, "A15")

    we["H4"] = "Проект"
    we["I4"] = "Задач"
    we["H4"].font = font_h
    we["I4"].font = font_h
    we["H4"].fill = fill_navy
    we["I4"].fill = fill_navy
    we["H4"].alignment = center
    we["I4"].alignment = center
    we["H4"].border = thin
    we["I4"].border = thin
    pr = defaultdict(int)
    for t in tasks:
        pr[t["project"] or "—"] += 1
    rr = 5
    for name, cnt in sorted(pr.items(), key=lambda x: -x[1]):
        we.cell(rr, 8, name).font = font_n
        we.cell(rr, 9, cnt).font = font_n
        we.cell(rr, 8).border = thin
        we.cell(rr, 9).border = thin
        we.cell(rr, 8).alignment = left
        we.cell(rr, 9).alignment = center
        rr += 1
    pie = PieChart()
    pie.title = "Задачи по проектам"
    labels = Reference(we, min_col=8, min_row=5, max_row=rr - 1)
    pdata = Reference(we, min_col=9, min_row=4, max_row=rr - 1)
    pie.add_data(pdata, titles_from_data=True)
    pie.set_categories(labels)
    pie.dataLabels = DataLabelList()
    pie.dataLabels.showPercent = True
    pie.dataLabels.showVal = False
    pie.dataLabels.showCatName = False
    pie.width = 12
    pie.height = 8
    we.add_chart(pie, "H15")

    for col, w in {"A": 22, "B": 12, "C": 24, "D": 16, "E": 16, "F": 14, "G": 4, "H": 24, "I": 10}.items():
        we.column_dimensions[col].width = w
    we.print_area = "A1:I32"


def render_image(tasks, meta, path: Path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    import matplotlib.patches as mpatches

    n = len(tasks)
    height = max(7.5, min(16, 2.2 + n * 0.32))
    fig, ax = plt.subplots(figsize=(16.5, height), dpi=160)
    fig.patch.set_facecolor("#F4F1EA")
    ax.set_facecolor("#FAF8F3")

    for i, t in enumerate(tasks):
        y = n - 1 - i
        start = t["start"] or meta["base"]
        end = t["actual_end"]
        ax.barh(y, end - start, left=start, height=0.62, color="#" + bar_color(t), edgecolor="none", zorder=3, alpha=0.92)
        if t["deadline"] and meta["base"] <= t["deadline"] <= meta["end"]:
            ax.plot([t["deadline"], t["deadline"]], [y - 0.38, y + 0.38], color="#C9A227", lw=1.6, zorder=4)
        if t["duration_h"] >= 1.3:
            mid = start + (end - start) / 2
            ax.text(mid, y, f"{t['duration_h']:.1f} ч", ha="center", va="center", fontsize=6.5, color="white", fontweight="bold", zorder=5)

    labels = [f"#{t['id']}  {t['short']}" if t["id"] else t["short"] for t in tasks]
    ax.set_yticks([n - 1 - i for i in range(n)])
    ax.set_yticklabels(labels, fontsize=7.2, color="#1F2937")
    ax.set_ylim(-0.8, n - 0.2)
    ax.set_xlim(meta["base"], meta["end"])
    span_h = (meta["end"] - meta["base"]).total_seconds() / 3600
    major = 2 if span_h <= 36 else 4
    ax.xaxis.set_major_locator(mdates.HourLocator(interval=major))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%d.%m\n%H:%M"))
    ax.xaxis.set_minor_locator(mdates.HourLocator(interval=1 if span_h <= 48 else 2))
    ax.tick_params(axis="x", labelsize=7.5, colors="#374151")
    ax.grid(axis="x", which="major", color="#D4CFC4", lw=0.7, zorder=0)
    ax.grid(axis="x", which="minor", color="#E8E4D9", lw=0.4, zorder=0)
    ax.axvline(meta["now"], color="#1B3A4B", ls="--", lw=1.0, zorder=2, alpha=0.7)
    ax.text(meta["now"], n - 0.15, f"  сейчас {meta['now'].strftime('%d.%m %H:%M')}", fontsize=7, color="#1B3A4B", va="bottom")

    d = meta["base"].date() + timedelta(days=1)
    while datetime.combine(d, datetime.min.time()) < meta["end"]:
        ax.axvline(datetime.combine(d, datetime.min.time()), color="#9A3412", ls="-", lw=0.9, alpha=0.45, zorder=1)
        d += timedelta(days=1)

    for spine in ax.spines.values():
        spine.set_color("#D4CFC4")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)

    patches = [
        mpatches.Patch(color="#2E7D4F", label="Завершена в срок"),
        mpatches.Patch(color="#B42318", label="Завершена с нарушением срока"),
        mpatches.Patch(color="#C47A16", label="На рассмотрении"),
        mpatches.Patch(color="#9A3412", label="На рассмотрении, срок нарушен"),
        mpatches.Patch(color="#2B6CB0", label="Выполняется"),
        mpatches.Patch(color="#C45C26", label="Выполняется, срок уже прошёл"),
    ]
    leg = ax.legend(handles=patches, loc="lower right", frameon=True, fontsize=7.5, fancybox=False, edgecolor="#D4CFC4", facecolor="#FAF8F3", title="Статус / срок     |     золотая черта — крайний срок")
    leg.get_title().set_fontsize(7.5)
    ax.set_title(f"Диаграмма Ганта · {meta['period']}", fontsize=13, fontweight="bold", color="#0F2C3A", pad=10, loc="left")
    ax.set_xlabel("Время", fontsize=9, color="#374151")
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=160, bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close()


def build_report(src: Path, out: Path, now: datetime, day_start_hour: int, make_image: bool) -> Path:
    tasks = load_tasks(src, now)
    base, end, step, n_slots = infer_window(tasks, now, day_start_hour)
    meta = {
        "source_name": src.name,
        "now": now,
        "base": base,
        "end": end,
        "step": step,
        "n_slots": n_slots,
        "period": period_label(base, end),
    }
    for t in tasks:
        t["start_h"] = hours_from(base, t["start"])
        t["end_h"] = hours_from(base, t["actual_end"])
        t["dl_h"] = hours_from(base, t["deadline"])

    exec_colors = exec_color_map(tasks)
    img_path = out.with_name(out.stem + "_gantt.png") if make_image else None
    if make_image:
        render_image(tasks, meta, img_path)

    wb = Workbook()
    write_summary(wb, tasks, meta, exec_colors)
    write_tasks(wb, tasks, meta)
    write_gantt_sheet(wb, tasks, meta, img_path)
    write_timeline(wb, tasks, meta, exec_colors)
    write_load(wb, tasks, exec_colors)
    for s in wb.worksheets:
        s.sheet_view.zoomScale = 100
    wb.worksheets[0].sheet_properties.tabColor = C["navy"]
    wb.worksheets[1].sheet_properties.tabColor = C["teal"]
    wb.worksheets[2].sheet_properties.tabColor = C["accent"]
    wb.worksheets[3].sheet_properties.tabColor = C["green"]
    wb.worksheets[4].sheet_properties.tabColor = C["gold"]
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    return out


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Анализ выгрузки задач и диаграмма Ганта")
    p.add_argument("input", help="xlsx выгрузки или папка с выгрузками")
    p.add_argument("-o", "--output", help="путь к готовому отчёту .xlsx")
    p.add_argument("--latest", action="store_true", help="взять самый свежий xlsx в папке")
    p.add_argument("--now", type=parse_now_arg, help='момент «сейчас», например "2026-09-15 10:56"')
    p.add_argument("--day-start", type=int, default=DEFAULT_DAY_START_HOUR, help="час начала оси (по умолчанию 7)")
    p.add_argument("--no-image", action="store_true", help="не строить PNG и не вставлять картинку")
    return p.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    src = Path(args.input).expanduser()
    if not src.exists():
        print(f"Нет файла или папки: {src}", file=sys.stderr)
        return 2
    if src.is_dir() or args.latest:
        folder = src if src.is_dir() else src.parent
        src = find_latest_xlsx(folder)
        print(f"Источник: {src}")
    now = args.now or guess_now_from_filename(src) or datetime.now()
    if args.output:
        out = Path(args.output).expanduser()
    else:
        stamp = now.strftime("%Y-%m-%d")
        out = src.parent / f"Диаграмма_Ганта_{stamp}.xlsx"
        if out.resolve() == src.resolve():
            out = src.parent / f"Диаграмма_Ганта_{stamp}_отчёт.xlsx"
    built = build_report(src, out, now, args.day_start, make_image=not args.no_image)
    print(f"Готово: {built}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
