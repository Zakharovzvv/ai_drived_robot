# Implementation Plan — Operator Camera & Diagnostics Stack

## Objectives

- Расширить стек оператора (CLI, FastAPI, Web UI), чтобы управлять Wi‑Fi/камерой ESP32 и отображать расширенную диагностику в реальном времени.
- Реализовать на прошивке ESP32 HTTP‑сервер камеры, управление Wi‑Fi и унифицированные статусные кадры для UNO/I2C, камеры и питания.
- Обеспечить поток логов и контроль включения/выключения стрима камеры через общую инфраструктуру команд.
- Синхронизировать документацию и инструменты запуска, чтобы оператор мог быстро поднять полный стек и прошить контроллер.

## Work Breakdown & Status

### 1. Firmware Networking Foundations

- [x] Добавить модуль `wifi_link` с управлением подключением, публикацией IP и повторными попытками (`firmware/src/esp32/include/wifi_link.hpp`, `.../wifi_link.cpp`).
- [x] Расширить `config.hpp` дефолтами Wi‑Fi/камеры и поддержкой переопределения через NVS/команды.
- [x] Обновить `platformio.ini` (раздел `esp32`) для поддержки Wi‑Fi задач и настроек камеры.

### 2. Firmware Camera HTTP Service

- [x] Реализовать `camera_http` с MJPEG/снимками и маршрутом `/stream` (`firmware/src/esp32/include/camera_http.hpp`, `.../camera_http.cpp`).
- [x] Интегрировать сервер в `main.cpp`: инициализация камеры, обработка REST команд (`CAMSTREAM`, `CAMCFG`).
- [x] Добавить синхронизацию настроек камеры в `vision_color.cpp` и `shelf_map.cpp` (транзиентные данные в диагностике).

### 3. Firmware Diagnostics & UNO Link

- [x] Расширить `i2c_link` обработкой ping/seq и упаковкой ошибок UNO (`firmware/src/esp32/include/i2c_link.hpp`, `.../i2c_link.cpp`).
- [x] Обновить `main.cpp` для публикации сводной структуры `Diagnostics` (serial, UNO, Wi‑Fi, камера, статус питания).
- [x] Гарантировать периодическую отправку данных оператору через UART CLI (`STATUS`, `DIAG`).

### 4. Operator Backend (FastAPI)

- [x] Добавить эндпоинты `GET /api/diagnostics`, `GET /api/logs`, `POST /api/camera/config`, `POST /api/camera/toggle` в `server.py`.
- [x] Реализовать WebSocket `ws/logs` с ретрансляцией журнала прошивки и снапшотом.
- [x] Перенастроить `ESP32Service` на новую структуру диагностических данных и поддержку команды `CAMSTREAM`.
- [x] Обновить загрузку окружения из `.env`, интегрировать новые параметры камеры.

### 5. Operator Frontend (Vite)

- [x] Переработать `index.html` и `src/main.js` добавив вкладки Diagnostics / Camera / Logs / Settings.
- [x] Реализовать компонент статусов с цветовой индикацией (UNO, Wi‑Fi, камера, питание) и управление камерой (toggle, refresh, quality sliders).
- [x] Подключить WebSocket поток логов и MJPEG кадры камеры, обработать авто‑переподключение.
- [x] Обновить стили (`src/style.css`) под новый UI и бейджи транспорта камеры.

### 6. Tooling, Tests & Runtime

- [x] Добавить `.env` шаблон для camera snapshot override и параметров Wi‑Fi.
- [x] Обновить `start_operator_stack.sh` для чтения `.env` и проверки зависимостей.
- [x] Расширить `pyproject.toml` зависимостями (`python-dotenv`, `watchfiles`, streaming utils).
- [x] Написать `tests/test_camera_config.py` на покрытие парсинга и команд `CAMCFG`.

### 7. Documentation & Release Prep

- [x] Обновить `CHANGELOG.md` разделом про камеру/диагностику (см. текущий diff).
- [ ] Провести валидацию на реальном железе: стрим камеры, логирование, переключение Wi‑Fi (ожидает доступа).
- [ ] Подготовить скриншоты и дополнение `docs/operator.md` про новые вкладки UI (после аппаратного теста).

### 8. Shelf Map Configuration UI

- [x] Добавить в backend FastAPI эндпоинты для чтения/изменения `ShelfMap` через команды `SMAP` ESP32.
- [x] Расширить сервис ESP32Link/OperatorService обработкой ответов `SMAP` и кешированием текущей карты.
- [x] Реализовать UI во вкладке Settings: визуальный редактор 3×3 с выбором цветов и кнопкой сохранения/сброса.
- [x] Добавить тесты Python/JS (unit и e2e mock) на парсинг/валидацию матрицы и вызовы REST API.

### 9. Structured Log Viewer

- [x] Backend: преобразовать поток логов в структурированные записи (поля timestamp/source/device/parameter/value/raw) и обновить REST/WS ответы.
- [x] Frontend: заменить текстовый вывод логов на таблицу с поиском, сортировкой и фильтрами, подключив новые данные.
- [x] UI/Styling: добавить адаптивные стили для таблицы логов и панели фильтров.
- [ ] Validation: вручную проверить загрузку снапшота, поток обновлений, поиск и фильтры на вкладке Logs.

## Recent changes (2025-10-12)

- Firmware: added X-Frame-Size header to camera snapshot responses and initial test-frame logging in `vision_color` to help validate real framebuffer dimensions. Camera init iterates candidate frame sizes and reports a `cam_max` value via CLI.
- Backend: `/api/diagnostics` enriched with camera runtime fields: `resolution`, `quality`, `available_resolutions`, and `max_resolution`. Backend also queries CAMCFG to populate these fields when serial is available.
- Frontend: Status card now displays camera `Resolution` and `Quality` in the Status tab; camera settings continue to populate from `available_resolutions` provided by backend.

These changes close parts of the Firmware Camera HTTP Service and Operator Backend tasks and provide better observability for the camera configuration and served image size.

## Acceptance Criteria

- ESP32 прошивка поднимает Wi‑Fi, запускает HTTP‑сервер камеры и публикует расширенные диагностические данные для CLI.
- Операторский backend обеспечивает REST/WebSocket доступ к командам, логам и настройкам камеры; CLI и web UI используют общие команды `CAMSTREAM`, `CAMCFG`.
- Веб-интерфейс показывает живые кадры камеры, статусы компонентов, поток логов и позволяет менять настройки камеры.
- Скрипты запуска и окружение позволяют оператору поднять стек и (при необходимости) залить прошивку одной командой.
- Документация и план синхронизированы с реализацией; остаются явно отмеченные пункты, ожидающие аппаратной проверки.
