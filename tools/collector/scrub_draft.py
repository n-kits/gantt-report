"""
ЧЕРНОВИК, ЗАМОРОЖЕНО (issue #3): очистка текста перед отправкой в LLM — телефоны, e-mail,
подписи писем, заголовки ответов и пересылок. В сборщик НЕ подключено.

Замер на архиве заявок (in/tasks_enriched_batch_size10.csv, колонки «Текст» и «Топонимы»):
    python tools/collector/scrub_draft.py in/tasks_enriched_batch_size10.csv
печатает число замен, долю потерянных топонимов и остатки телефонов / e-mail.
Результат на 38 634 текстах (30.09.2026): потеряно 0,03% топонимов, телефонов осталось 1, e-mail 0.
"""
import csv
import re
import sys
from collections import Counter

csv.field_size_limit(10**9)

# ссылки и сетевые пути — до поиска телефонов (в них много «телефоноподобных» чисел);
# ссылка обрывается на кириллице: названия бывают приклеены к ссылке без пробела
URL = re.compile(r"(?:https?://|www\.)[^\sЀ-ӿ]+|\\\\\d{1,3}(?:\.\d{1,3}){3}\\\S*")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# телефон: +7/7/8, затем 10 цифр с разделителями пробел, дефис, скобки; или +код страны 10–13 цифр
PHONE = re.compile(r"(?<![\w\d])(?:\+?[78][\s\-]*\(?\d{3}\)?[\s\-]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}"
                   r"|\+\d[\d\s\-\(\)]{9,17}\d)(?![\d])")
EXT = re.compile(r"(?i)\b(?:доб\.?|ext\.?|местный номер|внутр\.?|вн\.)\s*\(?[\d\-]{2,6}\)?")
SHORT = re.compile(r"(?i)\b(тел\.?|т\.|моб\.?|cell\.?|office:?|телефон:?)\s*:?\s*\d{2,3}[\-\s]\d{2}(?:[\-\s]\d{2})?\b")

CLOSING = re.compile(r"(?i)^\s*(с\s+уважением|с\s+ув\.|(best|kind|warm)\s+regards|regards|br,)\b")
DROP_LINE = re.compile(r"(?i)^\s*(отправлено (с|из)|sent from|get outlook|получено с помощью|ツ\s*$|--\s*$|_{3,}\s*$|-{5,}\s*$)")
REPLY_HDR = re.compile(r"(?i)^\s*(?:(?:пн|вт|ср|чт|пт|сб|вс|mon|tue|wed|thu|fri|sat|sun)[,.]?\s.*\d{4}.*:\s*$"
                       r"|\d{1,2}\.\d{1,2}\.\d{2,4},?\s+\d{1,2}:\d{2}.*:\s*$"
                       r"|.*(wrote|писал\(а\)|написал[а]?)\s*:?\s*$"
                       r"|(от|from)\s*:.*$"
                       r"|-+\s*(пересылаемое сообщение|original message|forwarded message)\s*-*\s*$)")
# поля заголовка письма — только сразу после «От:» (иначе «Тема:»/«Дата:» бывают полями заказа)
HDR_FIELD = re.compile(r"(?i)^\s*(отправлено|sent|дата|date|кому|to|копия|cc|тема|subject)\s*:")
NAME_BEFORE_PHONE = re.compile(r"(?:[А-ЯЁ][а-яё]+\.?\s+){1,2}[А-ЯЁ][а-яё]+\.?[\s,:–-]*\[телефон\]")
CORP = re.compile(r"(?i)all-russia state television and radio broadcasting company")

INLINE_SIG = re.compile(r"(?i)(?:--\s*)?(?:с\s+уважением|best regards|kind regards)[,!.]?")
BOUNDARY = re.compile(r"(?i)-{4,}|\s--\s|(?:от|from)\s*:|\d{1,2}\.\d{1,2}\.\d{2,4},?\s+\d{1,2}:\d{2}")


def cut_inline(line: str, c: Counter) -> str:
    """Подпись, склеенная с текстом в одну строку: от маркера до телефона / разделителя, не дальше 200 символов."""
    out, pos = [], 0
    for m in INLINE_SIG.finditer(line):
        if m.start() < pos or line[:m.start()].strip(" >") == "":
            continue                                   # маркер в начале строки — построчное правило
        end = min(len(line), m.end() + 200)
        b = BOUNDARY.search(line, m.end(), end)
        if b:
            end = b.start()
        ph = PHONE.search(line, m.end(), end)
        if ph:
            end = ph.end()
        out.append(line[pos:m.start()] + " [подпись] ")
        pos = end
        c["sig_inline"] += 1
    return "".join(out) + line[pos:]


def scrub(text: str) -> tuple[str, Counter]:
    """Текст → (очищенный текст, счётчики замен). Вырезаются блоки, цитаты сохраняются:
    заказ часто лежит в цитате ниже подписи («ответ поверх цитаты»)."""
    c = Counter()
    text, n = CORP.subn(" ", text)
    c["corp"] += n
    lines = [cut_inline(ln, c) for ln in text.split("\n")]
    out, sig_left, in_hdr = [], 0, False
    for ln in lines:
        s = ln.strip()
        if s.startswith(">"):
            s = s.lstrip("> ")
        if REPLY_HDR.match(s):
            c["reply_hdr"] += 1
            out.append("[цитата]")
            sig_left = 0
            in_hdr = True
            continue
        if in_hdr and HDR_FIELD.match(s):
            c["reply_hdr"] += 1
            continue
        in_hdr = False
        if CLOSING.match(s):
            c["signature"] += 1
            out.append("[подпись]")
            sig_left = 6          # до 6 строк подписи после «С уважением»
            continue
        if sig_left:
            # подпись: короткие строки (имя, должность, телефон, почта); длинная строка — уже текст
            if len(s) <= 90 and not re.search(r"(?i)(описание заказа|заголовок|тип графики)\s*:", s):
                sig_left -= 1
                c["sig_line"] += 1
                continue
            sig_left = 0
        if DROP_LINE.match(s):
            c["drop"] += 1
            continue
        out.append(s)
    t = "\n".join(out)
    t, n = URL.subn("[ссылка]", t); c["url"] += n
    t, n = EMAIL.subn("[email]", t); c["email"] += n
    t, n = EXT.subn("[доб.]", t); c["ext"] += n
    t, n = SHORT.subn(r"\1 [телефон]", t); c["short"] += n
    t, n = PHONE.subn("[телефон]", t); c["phone"] += n
    t, n = NAME_BEFORE_PHONE.subn("[контакт] [телефон]", t); c["name_phone"] += n
    return re.sub(r"(\[цитата\]\n?){2,}", "[цитата]\n", t), c


if __name__ == "__main__":
    rows = list(csv.DictReader(open(sys.argv[1], encoding="utf-8-sig", newline=""), delimiter=";"))
    total = Counter()
    lost_tasks = lost_all = lost = found = 0
    resid_phone = resid_mail = resid_sig = 0
    stem = lambda x: (lambda b: b.lower()[:max(4, len(b) - 2)])(re.sub(r"\s*\(.*\)", "", x))  # noqa: E731
    for r in rows:
        t = r["Текст"]
        clean, c = scrub(t)
        total.update(c)
        low, clow = t.lower(), clean.lower()
        present = [x for x in (y.strip() for y in (r["Топонимы"] or "").split(",")) if x and stem(x) in low]
        miss = [x for x in present if stem(x) not in clow]
        found += len(present); lost += len(miss)
        lost_tasks += bool(miss); lost_all += bool(present) and len(miss) == len(present)
        resid_phone += len(re.findall(r"(?<!\d)\+?[78][\s\-\(]*\d{3}[\s\-\)]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)", clean))
        resid_mail += len(EMAIL.findall(clean))
        resid_sig += bool(re.search(r"(?im)^\s*с\s+уважением", clean))
    print("замены:", dict(total))
    print(f"потеряно топонимов {lost} из {found} ({100 * lost / found:.2f}%), задач с потерей {lost_tasks}, все — {lost_all}")
    print(f"осталось похожих на телефон: {resid_phone}, e-mail: {resid_mail}, текстов с «С уважением»: {resid_sig}")
