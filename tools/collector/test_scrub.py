#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Тесты очистки текста (scrub.py) на выдуманных примерах — все имена, номера и адреса придуманы.

    python tools/collector/test_scrub.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from scrub import clean  # noqa: E402


class Phones(unittest.TestCase):
    def test_formats(self):
        for p in ["+7 9161234567", "+79161234567", "8-916-123-45-67", "8 916 123 45 67",
                  "+7 (916) 123-45-67", "8-(916)-123-45-67", "+44 20 7946 0958"]:
            with self.subTest(p=p):
                out = clean(f"Вопросы по карте: {p}")
                self.assertIn("[телефон]", out)
                self.assertNotRegex(out, r"\d{3}")

    def test_glued_to_name(self):
        out = clean("спасибо большое заранее! Аня89161234567")
        self.assertIn("[телефон]", out)
        self.assertNotRegex(out, r"\d")

    def test_short_and_ext(self):
        out = clean("тел. 12-34, доб. 5678, местный номер 12-34, ext. 4321")
        self.assertNotRegex(out, r"\d")
        self.assertIn("[доб.]", out)

    def test_not_phones(self):
        # даты, интервалы и номера заказов — не телефоны
        text = "Период с 01.09.2026 по 15.09.2026, заказ 1209845, высота 8848 м"
        self.assertEqual(clean(text), text)

    def test_name_before_phone(self):
        out = clean("Если что — звоните автору: Иван Петров 8-916-123-45-67")
        self.assertIn("[контакт] [телефон]", out)
        self.assertNotIn("Петров", out)


class Links(unittest.TestCase):
    def test_url_digits_are_not_phones(self):
        out = clean("Карта: https://yandex.ru/maps/?ll=37.617635,55.755814&z=8 и ещё http://ria.ru/20260901/123456789.html")
        self.assertEqual(out.count("[ссылка]"), 2)
        self.assertNotIn("[телефон]", out)

    def test_name_glued_to_url_survives(self):
        out = clean("Точка: https://maps.google.com/?q=55.75,37.61&z=8Москва")
        self.assertIn("[ссылка]Москва", out)

    def test_network_path(self):
        out = clean(r"Исходники: \\10.12.34.56\esu\2026\0901\karta.psd")
        self.assertEqual(out, "Исходники: [ссылка]")

    def test_email(self):
        out = clean("Пишите на ivan.petrov@example.ru или redakciya@example.com")
        self.assertEqual(out.count("[email]"), 2)
        self.assertNotIn("@", out)


class Signatures(unittest.TestCase):
    def test_block_signature(self):
        text = ("Нужна карта Херсонской области с линией фронта.\n"
                "С уважением,\nИван Иванов\nшеф-редактор\nтел. +7 916 123-45-67\nivanov@example.ru")
        out = clean(text)
        self.assertIn("Херсонской", out)
        self.assertIn("[подпись]", out)
        for gone in ("Иванов", "шеф-редактор", "916", "@"):
            self.assertNotIn(gone, out)

    def test_name_limit_long_line_is_text(self):
        # после «С уважением» длинная строка (> 90 символов) — уже не подпись, а текст заказа
        order = "Сделайте, пожалуйста, вторую карту — Запорожская область, Каменка-Днепровская и Энергодар, с подписями"
        out = clean(f"С уважением,\n{order}")
        self.assertIn("Энергодар", out)

    def test_signature_limit_six_lines(self):
        sig = "\n".join(["С уважением,", "Анна Смирнова", "редактор", "Отдел выпуска", "этаж 5",
                         "комната 12", "офис на Шаболовке", "Карта Курской области к 18:00"])
        out = clean(sig)
        self.assertNotIn("Смирнова", out)
        self.assertIn("Курской", out)      # седьмая строка после маркера — за лимитом, остаётся

    def test_inline_signature(self):
        # переносы потеряны: заказ + подпись + служебная строка в одной строке
        out = clean("Карта Белгорода и Шебекино к эфиру. С уважением, Анна Смирнова +79161234567 Отправлено с iPhone")
        self.assertIn("Белгорода", out)
        self.assertIn("[подпись]", out)
        self.assertNotIn("Смирнова", out)
        self.assertNotIn("9161234567", out)
        self.assertNotIn("iPhone", out)

    def test_corporate_phrase(self):
        out = clean("Best regards, John Smith\nAll-Russia State Television and Radio Broadcasting Company +7 4951234567")
        self.assertNotIn("Broadcasting", out)
        self.assertNotIn("4951234567", out)

    def test_service_lines(self):
        out = clean("Карта Курска\n--\nОтправлено с iPhone\nПишите если возникли вопросы ツ")
        self.assertNotIn("iPhone", out)
        self.assertIn("Курска", out)


class Quotes(unittest.TestCase):
    def test_reply_above_quote_keeps_order(self):
        text = ("Да, нужна ещё и Харьковская.\nС уважением, Пётр\n\n"
                "-----Original Message-----\nFrom: Петров Пётр <petrov@example.ru>\n"
                "Sent: Monday, September 28, 2026 10:15 AM\nTo: Карты <maps@example.ru>\nSubject: карта\n\n"
                "Сделайте карту Курской области: Суджа, Коренево.")
        out = clean(text)
        for keep in ("Харьковская", "Курской", "Суджа"):
            self.assertIn(keep, out)
        self.assertIn("[цитата]", out)
        for gone in ("Monday", "@", "Petrov".lower()):
            self.assertNotIn(gone, out)

    def test_russian_reply_header(self):
        out = clean("Принято.\n\n28.09.2026, 10:15, Иван Иванов пишет:\n> Карта Донецка нужна к 12:00")
        self.assertIn("Донецка", out)
        self.assertNotIn("Иванов", out)

    def test_subject_as_order_field(self):
        # «Тема:» / «Дата:» — поля самого заказа, если не идут сразу после «От:»
        text = "Тема: Наводнение в Якутии\nДата: 28.09.2026\nОписание заказа: карта Ленска"
        self.assertEqual(clean(text), text)


class General(unittest.TestCase):
    def test_idempotent(self):
        text = ("Карта Курска.\nС уважением,\nИван Иванов\n+7 916 123-45-67\n"
                "-----Original Message-----\nFrom: x@example.ru\nSubject: карта\n\nhttps://example.ru/a?b=1")
        once = clean(text)
        self.assertEqual(clean(once), once)

    def test_empty(self):
        self.assertEqual(clean(""), "")
        self.assertEqual(clean(None), "")


if __name__ == "__main__":
    unittest.main(verbosity=1)
