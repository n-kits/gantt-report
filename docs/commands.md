# Справочник команд

Все команды — из корня репозитория (`gantt_report`), в PowerShell или cmd. Где нужен компьютер со сборщиком — сказано.
Подробности устройства — в [README](../README.md).

**Где что лежит на ПК со сборщиком:** `%LOCALAPPDATA%\gantt-collector\`
`config.json` — настройки · `collector.log` — журнал · `archive.sqlite` — архив задач · `geo-state.json` — очередь анализа LLM ·
`kdf-salt.json` — соль шифрования · `data-repo\` — копия ветки data · `edge-profile\` — вход в Bitrix.

---

## Сборщик: обычная работа

| Что сделать | Команда |
|---|---|
| Запустить сбор и публикацию сейчас (не дожидаясь расписания; из консоли — всегда, в любое время суток) | `python tools/collector/collect.py -v` |
| То же без консоли (ярлык, другой планировщик) — в обход расписания `schedule` | `python tools/collector/collect.py --force` |
| Проверка без публикации (собрать, но ничего не отправлять) | `python tools/collector/collect.py --dry-run -v` |
| Войти в Bitrix заново (сессия истекла, в журнале `LOGIN_REQUIRED`) | `python tools/collector/collect.py --login` |
| Сменить пароль для коллег и интервал | `python tools/collector/collect.py --setup` |
| Справка по всем ключам | `python tools/collector/collect.py --help` |

Если запуск уже идёт (Планировщик или ручной), второй выйдет с сообщением «Предыдущий запуск ещё идёт» — это нормально.

## Анализ LLM (карта топонимов, темы, «География»)

| Что сделать | Команда |
|---|---|
| Включить анализ | `python tools/collector/collect.py --llm on` · или двойной щелчок `tools\collector\llm-on.cmd` |
| Выключить анализ (лента продолжает обновляться) | `python tools/collector/collect.py --llm off` · `llm-off.cmd` |
| Состояние и сколько задач ждёт | `python tools/collector/collect.py --llm status` · `llm-status.cmd` |
| Повторить неудавшийся анализ (сбой API, отказ модели) — все задачи очереди | `python tools/collector/collect.py --llm-retry` |
| То же для конкретных задач | `python tools/collector/collect.py --llm-retry 1210931 1210934` |

- Неудачный анализ сборщик и так повторяет сам: через 1 ч, потом через 2 ч, и бросает после 3 попыток.
  `--llm-retry` сбрасывает счётчик — задачу разберёт следующий запуск (сразу — `collect.py -v`).
- `--llm-retry` работает для задач живого окна (последние 3 дня). Для более старых — дообработка архива ниже.

**Дообработка архива** (заказы без анализа — например, догруженные `--backfill` или упавшие за окно):

| Шаг | Команда |
|---|---|
| 1. Скачать описания задач без анализа (Bitrix → очистка → архив) | `python tools/collector/llm_archive.py fetch` |
| 2. Разобрать их (вариант B — регион свободной строкой, выбран по A/B-тесту) | `python tools/collector/llm_archive.py apply --variant B` |
| A/B-тест вариантов запроса на выборке (в архив не пишет) → `in/llm-test.html` | `python tools/collector/llm_archive.py test --n 80` |

## Архив и календарик «Период»

| Что сделать | Команда |
|---|---|
| Догрузить прошлые дни из Bitrix (и обновить их статусы) | `python tools/collector/collect.py --backfill 2026-09-01 2026-09-30` |
| То же — с даты по сегодня | `python tools/collector/collect.py --backfill 2026-09-01` |
| Выгрузить день из архива в Excel заново | `python tools/collector/collect.py --export-day 2026-09-28` |

Для дней старше ~5 суток нужен пресет без ограничения по давности — `history_url` в `config.json`.

## Планировщик Windows (задача `GanttCollector`)

| Что сделать | Команда |
|---|---|
| Остановить идущий запуск | `schtasks /End /TN GanttCollector` |
| Приостановить расписание | `schtasks /Change /TN GanttCollector /DISABLE` |
| Возобновить расписание | `schtasks /Change /TN GanttCollector /ENABLE` |
| Запустить по расписанию сейчас | `schtasks /Run /TN GanttCollector` |
| Посмотреть состояние, последний и следующий запуск | `schtasks /Query /TN GanttCollector /V /FO LIST` |
| Создать / пересоздать задачу (по `interval_min` и `align_minute` из `config.json`) | `python tools/collector/collect.py --install-task` |
| Удалить задачу | `python tools/collector/collect.py --remove-task` |

## Журнал

| Что сделать | Команда (PowerShell) |
|---|---|
| Последние 50 строк | `Get-Content $env:LOCALAPPDATA\gantt-collector\collector.log -Tail 50` |
| Следить за журналом в реальном времени | `Get-Content $env:LOCALAPPDATA\gantt-collector\collector.log -Tail 20 -Wait` |
| Только ошибки и предупреждения | `Select-String -Path $env:LOCALAPPDATA\gantt-collector\collector.log -Pattern 'ERROR\|WARNING' \| Select-Object -Last 20` |

## Вкладка «Аналитика»

| Что сделать | Команда |
|---|---|
| Стенд по локальному архиву без пароля → `in/analytics.html` | `python tools/collector/analytics.py` |

Открыть: `http://localhost:8765/in/analytics.html` (нужен локальный сервер, см. ниже).
На сайт файл `analytics.json` выкладывает сам сборщик; выключить — `"publish_analytics": false` в `config.json`.

## Места и карта

| Что сделать | Команда |
|---|---|
| Подозрительные пары мест (одно название — разные точки) | `python tools/collector/places.py --check` |
| Заново поискать в геокодере точки «оценка модели» в архиве (найденное — в архив и Excel, ненайденное — в `geo-unresolved.log`) | `python tools/collector/llm_archive.py regeo` |
| Места, которые геокодер не нашёл (точка — оценка модели) | `Get-Content $env:LOCALAPPDATA\gantt-collector\geo-unresolved.log -Tail 30` |
| Страница проверки карты глазами → `in/geo-review.html` | `python tools/collector/geo_review.py` |
| Варианты отрисовки точек по свежим данным → `in/geo-compare.html` | `python tools/collector/geo_review.py --compare` |
| Стенд подбора размера точек → `in/geo-sizes.html` | `python tools/collector/geo_review.py --sizes` |
| Добавить точки в кэш координат из GeoJSON | `python tools/collector/collect.py --import-geocache путь\к\файлу.geojson` |
| Пересобрать справочник регионов `data/admin1.json.gz` (Natural Earth) | `python tools/build_admin1.py in/analyze_geocode/ne_10m_admin_1_states_provinces.geojson in/analyze_geocode/cntpol10.geojson` |

## Сайт локально

| Что сделать | Команда / адрес |
|---|---|
| Запустить локальный сервер (окно не закрывать) | `python -m http.server 8765` |
| Главная с вашими правками и живыми данными с GitHub | `http://localhost:8765/` |
| Сразу на вкладке «Аналитика» | `http://localhost:8765/#analytics` |
| Подменить данные ленты (тестовый файл) | `http://localhost:8765/?data=tests/fixtures/live-sample.json` (пароль `test`) |
| Подменить данные аналитики | `http://localhost:8765/?analytics-data=путь/к/analytics.json#analytics` |
| Опубликованный сайт | `https://n-kits.github.io/gantt-report/` |

После изменений в коде обновлять страницу без кэша: **Ctrl+F5**.

## Тесты

| Что проверить | Команда / адрес |
|---|---|
| Модель ленты, разбор Bitrix, аналитика (в браузере) | `http://localhost:8765/tests/index.html` |
| Самопроверка сборщика (Playwright + Edge, без Bitrix) | `python tools/collector/selftest.py` |
| Очистка текста от личных данных | `python tools/collector/test_scrub.py` |
| Тестовые данные с картой → `tests/fixtures/live-geo-sample.json` | `python tools/collector/make_geo_sample.py` |

## Прочее

| Что сделать | Команда |
|---|---|
| Excel-отчёт «Лента времени» из выгрузки (исходный генератор) | `python tools/gantt_report.py выгрузка.xlsx -o отчёт.xlsx` |
| То же по самой свежей выгрузке в папке | `python tools/gantt_report.py папка --latest` |
| Подбор палитры цветов исполнителей | `python tools/palette.py` |

---

## Основные настройки `config.json`

Меняются в `%LOCALAPPDATA%\gantt-collector\config.json`, действуют со следующего запуска.

| Ключ | Что значит |
|---|---|
| `interval_min`, `align_minute` | период запуска Планировщиком и привязка к минуте часа (после смены — `--install-task`) |
| `schedule` | частота по времени суток, например `[{"from": "07:00", "to": "23:00", "every_min": 15}, {"from": "23:00", "to": "07:00", "every_min": 60}]`: Планировщик запускает раз в `interval_min`, сборщик сам пропускает запуски, если по расписанию рано; сайт получает интервал и не предупреждает зря |
| `llm` | анализ через Claude вкл/выкл (удобнее `--llm on/off`) |
| `days` | ширина живого окна, суток (3) |
| `refresh_days` | сколько закрытых дней перечитывать раз в сутки (14) |
| `history_url` | пресет Bitrix без ограничения по давности — для `--backfill` и обновления статусов |
| `publish_days` / `publish_analytics` | публиковать архив по дням / файл вкладки «Аналитика» |
| `archive`, `archive_dir` | локальный архив и папка Excel-выгрузок |
| `cartographers` | фамилии картографов для профилей во вкладке «Аналитика» (в репозиторий не попадают) |
| `password` | пароль для коллег — менять только через `--setup` |
