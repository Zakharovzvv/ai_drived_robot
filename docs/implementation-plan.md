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
- [x] Перенести управление запуском в `scripts/operator_stack.sh`, читающий `.env`, проверяющий зависимости и заменяющий устаревшие `start/stop` скрипты в backend.
- [x] Расширить `pyproject.toml` зависимостями (`python-dotenv`, `watchfiles`, streaming utils).
- [x] Написать `tests/test_camera_config.py` на покрытие парсинга и команд `CAMCFG`.
- [x] Добавить Dockerfile для backend и frontend, а также `docker-compose.yml` для запуска стека в контейнерах.
- [x] Добавить `scripts/operator_stack_docker.sh` с командами `build/start/status/logs/stop/restart` для управления контейнерным стеком.
- [x] Автоматизировать запуск и остановку serial bridge в `scripts/operator_stack_docker.sh`, читая параметры из `.env`.

### 7. Documentation & Release Prep

- [x] Обновить `CHANGELOG.md` разделом про камеру/диагностику (см. текущий diff).
- [ ] Провести валидацию на реальном железе: стрим камеры, логирование, переключение Wi‑Fi (ожидает доступа).
- [ ] Подготовить скриншоты и дополнение `docs/operator.md` про новые вкладки UI (после аппаратного теста).

### 12. Test Automation & QA

- [x] Добавить единый скрипт `scripts/run_all_tests.sh`, запускающий backend pytest и фронтенд Vitest, с проверкой зависимостей.
- [x] Настроить локальный pre-commit хук, вызывающий скрипт, и задокументировать включение (`docs/commit-hooks.md`).
- [x] Настроить GitHub Actions workflow `.github/workflows/ci.yml`, повторяющий локальные проверки на push/PR.
- [ ] Автоматизировать прогон линтеров (flake8/ruff, eslint/stylelint) и интегрировать в общий пайплайн.

### 13. Wi-Fi WebSocket Control (2025-10-13)

- [x] Firmware: добавить WebSocket сервер команд (`/ws/cli`) поверх `esp_http_server`, запуск/остановка при изменении статуса Wi‑Fi.
- [x] Firmware: вынести обработку CLI-команд в общий модуль с мьютексом, чтобы одно и то же состояние обслуживал и Serial, и WebSocket.
- [x] Backend: реализовать транспорт WebSocket (env `OPERATOR_CONTROL_TRANSPORT=ws`, `OPERATOR_WS_ENDPOINT`) и интегрировать в `OperatorService` наряду с serial.
- [x] Backend: покрыть новый транспорт юнит-тестами (мок `websocket-client`) и убедиться, что парсинг CLI-ответов совместим с существующей логикой.
- [x] Docs: обновить `docs/operator.md` и `CHANGELOG.md` описанием Wi‑Fi/WebSocket управления и новых переменных окружения.
- [ ] Validation: локально проверить команды `STATUS`, `CAMCFG`, `CAMSTREAM` через WebSocket и задокументировать ограничения (лог-поток, необходимость железа).
- [x] Validation: локально проверить команды `STATUS`, `CAMCFG`, `CAMSTREAM` через WebSocket и задокументировать ограничения (лог-поток, необходимость железа).

### 14. Dual Control Transport Selection (2025-10-13)

- [~] Backend: внедрить режим `auto` с приоритетом Wi-Fi и резервным переходом на UART, собирающий состояние доступных транспортов и сохраняя оба соединения конфигурированными. — реализован приоритет Wi-Fi с fallback внутри `OperatorService`, предстоит дополнительно отладить сценарии без железа и покрыть тестами.
- [x] Backend: кэшировать последний успешный Wi-Fi endpoint и восстанавливать его при старте, устраняя зависимость от переменной `OPERATOR_WS_ENDPOINT`.
- [x] Backend API: расширить `/api/info` и добавить эндпоинт переключения транспорта, чтобы фронтенд мог запрашивать и задавать активный канал. — добавлены `/api/control/transport` (GET/POST) и выдача метаданных транспорта.
- [x] Tests: покрыть автоматический выбор и переключение транспорта юнит-тестами `OperatorService`, включая мок Wi-Fi и UART статусы. — добавлен `test_transport_control.py`, проверяющий fallback, смену режимов и обработку ошибок конфигурации.
- [x] Frontend Header: добавить элемент управления выбором транспорта (Wi-Fi/UART/Auto) и отображение статуса каждого канала. — реализован селектор в `Header.jsx` с бейджами состояния транспорта.
- [x] Frontend Settings: отобразить состояние обоих транспортов и ссылку на ручной выбор, синхронизируя с новым API. — добавлена карточка `Control Link` с подробной диагностикой и кнопками переключения.
- [x] Frontend Settings/Header: унифицировать источники данных для статусов транспортов, чтобы бейджи и заголовок использовали одинаковое состояние контроля.
- [ ] Docs: обновить `docs/operator.md` и `.env` описание переменных для нового режима управления транспортом.

### 15. Wi-Fi Telemetry Parity (2025-10-13)

- [x] Firmware: дублировать UART-журнал в кольцевой буфер и предоставить CLI-команду/WS-канал для выгрузки batched логов по Wi‑Fi.
- [x] Firmware: расширить WebSocket CLI поддержкой push-уведомлений/heartbeats, чтобы оператор мог получать логи и статус без UART.
- [x] Firmware: добавить автоматическое переподключение Wi‑Fi при потере сети, чтобы канал CLI оставался доступным.
- [x] Backend: реализовать сбор логов через Wi‑Fi (`ESP32WSLink.collect_pending_logs`) и использовать его, когда активен транспорт Wi‑Fi или UART недоступен.
- [x] Backend: адаптировать фоновый опрос (`_poll_loop`, диагностика) к приоритету Wi‑Fi, обрабатывая отсутствие UART без ошибок и гарантируя опрос статус/камера команд.
- [x] Frontend: убедиться, что выбор транспорта «Wi-Fi»/«Auto» корректно отображает отсутствие UART и что поток логов продолжается через новый канал (Status таб обновляется после переключения транспорта).
- [ ] Validation: отключить UART, оставить только Wi‑Fi, проверить управление (STATUS, CAMCFG, START), телеметрию и стрим логов через backend/web UI; задокументировать результат.

- [x] Backend: реализовать авто-повторный probe транспорта при ошибках `SerialNotFoundError`, чтобы стек корректно подхватывал ESP32, подключенный после старта.
- [ ] Validation: локально запустить стек (`operator_stack_docker.sh restart`), удерживать Wi‑Fi транспорт активным ≥5 минут, подтвердить отсутствие переподключений и задокументировать результат в `docs/operator.md`/`CHANGELOG.md` при необходимости.

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

### 10. Operator Frontend — React Router 7 Migration

- [ ] Зафиксировать текущие пользовательские потоки, API-вызовы и структуру state машины во фронтенде, чтобы обеспечить функциональный паритет после миграции (док пока не обновляли).
- [x] Спроектировать новую файловую структуру Vite-проекта: корневой layout, маршруты Telemetry/Camera/Status/Settings/Logs/Output, общие компоненты и хуки для API/WS.
- [~] Перенести существующую логику UI в компоненты React с использованием React Router 7, сохранив все возможности (телеметрия, камера, логи, управление картой полок, настройки). — основные страницы готовы, требуется финальная сверка поведения и тестирование.
- [x] Настроить глобальное состояние/контексты для телеметрии, статусов и уведомлений; обеспечить восстановление WebSocket соединений как в текущей реализации.
- [ ] Обновить тесты (`shelfMap.spec.js` и новые компонентные/интеграционные тесты) под React-компоненты и маршруты.
- [ ] Перепроверить стили и адаптивность; при необходимости вынести общие стили в CSS-модули/SCSS без изменения визуального поведения.
- [x] Обновить процессы сборки (Vite config, `package.json`) и документацию по запуску фронтенда (черновые изменения внесены, нужна доп. документация).
- [x] Перенести фронтенд в корневой каталог `frontend/` и настроить путь сборки под новую структуру.

### 11. Operator Backend — Modular FastAPI Layout

- [x] Инвентаризировать текущие зависимости модулей (`cli.py`, `server.py`, `esp32_link.py`) и выделить слои: API маршруты, сервисы, адаптеры работы с UART/WebSocket. — зависимости разнесены между `services/operator_service.py`, `api/routes.py` и `services/dependencies.py`.
- [x] Перенести backend в корневой каталог `backend/` и настроить путь сборки под новую структуру.
- [x] Переразбить существующий код FastAPI на пакеты (`api`, `services`, `adapters`, `models`) без изменения поведения эндпоинтов и фоновых задач.
- [x] Вынести схемы запросов/ответов в Pydantic-модели, синхронизировать JSON-форматы с фронтендом.
- [x] Дополнить тесты backend (юнит/интеграционные) для новой структуры, обеспечить запуск через `pytest` и существующие CLI проверки. — добавлены интеграционные тесты FastAPI маршрутов с заглушкой `OperatorService`, `pytest` покрывает базовые сценарии.
- [x] Обновить документацию (`docs/operator.md`, README) по новой структуре backend и инструкциям запуска. — `docs/operator.md` дополнен описанием пакетов `api/`, `services/`, `models/`.

### 16. Drive Base Hardware Update (2025-10-15)

- [x] Обновить `docs/RBM-Robot_Architecture.md` под двухмоторное шасси, энкодер захвата и новую позицию камеры.
- [x] Актуализировать `docs/wire.md`: силовые цепи, распиновка UNO, smoke-test для энкодера захвата.
- [x] Переписать `docs/ICD — Протокол обмена ESP32↔UNO.md` с учётом двух приводных каналов и новой телеметрии.
- [x] Зафиксировать изменения в `CHANGELOG.md`.

## Recent changes (2025-10-12)

- Firmware: added X-Frame-Size header to camera snapshot responses and initial test-frame logging in `vision_color` to help validate real framebuffer dimensions. Camera init iterates candidate frame sizes and reports a `cam_max` value via CLI.
- Backend: `/api/diagnostics` enriched with camera runtime fields: `resolution`, `quality`, `available_resolutions`, and `max_resolution`. Backend also queries CAMCFG to populate these fields when serial is available.
- Frontend: Status card now displays camera `Resolution` and `Quality` in the Status tab; camera settings continue to populate from `available_resolutions` provided by backend.
- Frontend: Reworked toast system to auto-dismiss after 5 seconds with strict pruning so notifications never pile up on screen.
- Firmware: probing routine now validates each candidate frame (dimensions + JPEG conversion) before advertising `cam_max`, preventing corrupted frames from being marked supported.

These changes close parts of the Firmware Camera HTTP Service and Operator Backend tasks and provide better observability for the camera configuration and served image size.

## Acceptance Criteria

- ESP32 прошивка поднимает Wi‑Fi, запускает HTTP‑сервер камеры и публикует расширенные диагностические данные для CLI.
- Операторский backend обеспечивает REST/WebSocket доступ к командам, логам и настройкам камеры; CLI и web UI используют общие команды `CAMSTREAM`, `CAMCFG`.
- Веб-интерфейс показывает живые кадры камеры, статусы компонентов, поток логов и позволяет менять настройки камеры.
- Скрипты запуска и окружение позволяют оператору поднять стек и (при необходимости) залить прошивку одной командой.
- Все изменения проходят локальный и CI прогон тестов (backend pytest + frontend Vitest) перед мёржем; разработчики используют pre-commit хук для авто-проверки.
- Документация и план синхронизированы с реализацией; остаются явно отмеченные пункты, ожидающие аппаратной проверки.
