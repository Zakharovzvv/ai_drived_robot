# Changelog

## [2025-10-17]

### Frontend (Operator Console)

- **Redesigned Status Page**: Restructured device status display into a two-column layout with ESP32 on the left and Arduino UNO on the right.
  - **ESP32 Device Card**: Displays overall device status with nested service cards for:
    - UART (Serial) - connection port, update age
    - Wi-Fi - IP address, WebSocket endpoint, transport availability
    - Camera - resolution, quality, streaming status, transport type
    - I2C (UNO Link) - connection status to Arduino
    - Bluetooth - placeholder for future implementation
  - **Arduino UNO Device Card**: Shows device status with service cards for:
    - Motors (Drive) - left/right motor values, speed in mps
    - Line Sensors - left/right sensor readings, threshold
    - Manipulator - lift position (mm), grip angle (°), encoder values
    - Power & Battery - voltage, E-Stop status
  - Each service card shows connection indicator (green/red), online/offline state, and relevant telemetry data
  - System Info sections display device-level diagnostic data (state ID, error flags, sequence ACK)
  - This hierarchical view clearly represents the robot's two-MCU architecture and their respective subsystems

### Firmware (ESP32)

- Camera snapshot handler now serialises access with a FreeRTOS mutex, adds `Connection: close`, and logs send failures so concurrent REST requests no longer stack or corrupt frames.
- WebSocket CLI bridge supports up to eight clients, evicts stale sockets, and tracks heartbeat opt-in per peer; idle detection is more accurate thanks to centralised touch handling.

### Tooling & Operations

- `scripts/flash_firmware.sh` auto-detects common USB serial adapters and passes the port to PlatformIO when flashing the ESP32-S3, trimming manual `--upload-port` lookups.
- Updated `.serial_bridge.pid` and `.wifi_last_ip` with the latest operator-stack session data after wiring diagnostics.

### Documentation (Wiring)

- `docs/wire.md` now pairs the Arduino UNO pin map with an ESP32-S3 table and emphasises SDA/SCL pull-ups to 3.3 V, helping avoid miswired I²C links during bring-up.

## [2025-10-16]

### Frontend

- Unified control-transport status across the operator console: the header badge, Control Link card, and Wi-Fi settings now share a single state source from `OperatorProvider`, so transport availability and endpoints stay in sync regardless of where they are viewed.
- Refined Wi-Fi settings messaging to reflect live transport data, clarifying when the link is online, on standby for failover, or waiting for discovery.

### Backend & Tooling

- Hardened camera snapshot handling in `OperatorService`: socket-level timeouts are now converted into `CameraSnapshotError`, so Wi-Fi dropouts surface as clean status messages instead of stack traces in the backend logs and WebSocket stream.
- Added `scripts/flash_firmware.sh` helper with inline usage notes to flash the ESP32-S3 and Arduino Uno targets via PlatformIO (`all`, `esp32`, or `uno` modes) without retyping long commands.
- Normalized Wi-Fi transport diagnostics: `/api/diagnostics`, `/api/control/transport`, and the frontend now consume the same control snapshot so the reported IP, availability, and last-success timestamps stay consistent even after endpoint changes or reconnects; regression tests cover the transport summary.

### Firmware & Testing

- Added CLI command group `CTRL` (firmware `main.cpp`), enabling manual DRIVE/TURN/ELEV/GRIP/HOME invocations for benchtop validation via `rbm-operator command`.
- Authored `docs/testing/basic-motion-test.md` with a motion smoke-test checklist and referenced it from the deploy/operator guides for quick access during hardware bring-up.

## [2025-10-15]

### Documentation & Architecture

- Updated mechanical documentation (`docs/RBM-Robot_Architecture.md`, `docs/wire.md`, `docs/ICD — Протокол обмена ESP32↔UNO.md`) to reflect the dual-motor drive base, gripper encoder, refreshed camera mounting and the component-to-element mapping table.
- Cross-referenced wiring/architecture revisions and clarified ICD telemetry for the new encoder layout and reserved `vy` field in `DRIVE`.

### Firmware & Telemetry

- Arduino UNO firmware (`firmware/src/uno/main.cpp`) reworked for the dual-drive base: new motor pin map, quadrature gripper encoder capture, lift/grip safety limits, and telemetry packing that matches ICD v0.3.
- ESP32 firmware (`firmware/src/esp32/include/i2c_link.hpp`, `.../i2c_link.cpp`, `.../main.cpp`, `.../config.hpp`) updated to the same protocol: revised drive feedback fields, grip configuration writer, STATUS output with encoder counts, and lint fixes in the CLI telemetry formatting.

## [2025-10-14]

### Added (2025-10-14)

- Tooling: `scripts/operator_stack_docker.sh` now persists the last working Wi‑Fi CLI endpoint in `.state/backend/last_wifi_endpoint.json` (mirrored to `.wifi_last_ip`) and rewrites the cache whenever discovery, ping, or a manual `OPERATOR_WS_ENDPOINT` override succeeds.
- Backend: refinements to `OperatorService` and WebSocket link; added/updated tests for transport, Wi‑Fi caching and WS link.
- Frontend: header/control transport selector and settings/status UI tweaks.
- Firmware: additional WebSocket CLI support, log sink and CLI WebSocket bridge improvements, camera HTTP tweaks and diagnostics.
- Tooling & Docs: updated Docker stack script (`scripts/operator_stack_docker.sh`), `.env` and operator documentation.

### Fixed (2025-10-14)

- Firmware: WebSocket CLI теперь отвечает на Ping/Pong и снимает зависшие сессии, что предотвращает периодические обрывы Wi‑Fi транспорта оператора.
- Backend/Frontend: восстановлен полный список разрешений камеры в настройках; опции выше заявленного `cam_max` помечаются как «unsupported», но остаются видимыми для ручного выбора.


## [2025-10-13]

### Highlights

- Firmware: добавлен кольцевой буфер логов с зеркалированием UART → WebSocket, новая команда CLI `LOGS` и единый `log_sink`, обеспечивающий идентичный вывод по Wi‑Fi и при отключённом UART.
- Backend: `OperatorService` автоматически подхватывает IP ESP32 из телеметрии, регистрирует Wi‑Fi транспорт без ручной настройки `OPERATOR_WS_ENDPOINT` и ретранслирует поток логов через `ESP32WSLink.collect_pending_logs`.
- Backend: Wi‑Fi транспорт теперь отключается аккуратно, если отсутствует `websocket-client`; UART остаётся рабочим, а статус транспорта отражает причину недоступности.
- Firmware: внедрён WebSocket-мост `/ws/cli`, повторяющий UART CLI по Wi‑Fi; обработчик команд вынесен в общий модуль с мьютексом для безопасного параллельного доступа с Serial и WebSocket.
- Backend: `OperatorService` научился работать через WebSocket-транспорт (`OPERATOR_CONTROL_TRANSPORT=ws`, `OPERATOR_WS_ENDPOINT`); добавлен клиент `websocket-client` и совместимые тесты `test_ws_link.py`.
- Backend: реализовано управление транспортом — `OperatorService` теперь поддерживает режим `auto` с fallback на UART, а REST добавил `/api/control/transport` (GET/POST) и расширенный `/api/info`, возвращающие состояние доступных каналов.
- Tests: добавлен `backend/operator/tests/test_transport_control.py`, покрывающий fallback с Wi‑Fi на UART и смену режима управления.
- Tooling/Docs: обновлены зависимости `backend/operator/pyproject.toml` и документация оператора (описание нового транспорта и переменных окружения).
- Frontend: шапка консоли получила селектор режима управления Wi-Fi/UART/Auto с бейджами состояния, а вкладка Settings теперь включает карточку Control Link с диагностикой каналов и быстрым переключением.

## [2025-10-12]

### Refactor (2025-10-12)

- Performed a large refactor across frontend and backend: reorganized files, updated APIs and client state handling, and cleaned tooling.
- Files changed (summary from workspace):
  - Modified: `.env`, `.gitignore`, `CHANGELOG.md`, `docs/deploy-guide.md`, `docs/implementation-plan.md`, `docs/operator.md`, `tools/operator/web/index.html`, `tools/operator/web/package.json`, `tools/operator/web/vite.config.js`, `frontend/web/src/constants.js`, `frontend/web/src/state/OperatorProvider.jsx`
  - Deleted: multiple legacy operator scripts and modules under `tools/operator/` (removed during refactor)
  - Added/Untracked: `backend/`, `docker-compose.yml`, `docker/`, `frontend/`, `scripts/` (moved/renamed project layout)

### Tooling & QA (2025-10-12)

- Added unified test runner `scripts/run_all_tests.sh` that executes backend `pytest` suite and frontend `pnpm test -- --run`, auto-detecting the project virtualenv and validating prerequisites.
- Introduced repository-local pre-commit hook (`.githooks/pre-commit`) invoking the unified runner to block commits when tests fail.
- Documented hook enablement and environment bootstrap steps in `docs/commit-hooks.md` and updated operator docs with quick-start notes.
- Created CI workflow `.github/workflows/ci.yml` mirroring local checks for push/PR validation (installs backend dev extras, runs pytest, installs pnpm dependencies, runs Vitest).

Note: see the git diff for the full list of file moves/deletions; this changelog entry highlights the top-level structural refactor and the toast/notification fix implemented on the frontend.

## [2025-10-11]

### Added

- Operator CLI (`backend/operator/cli.py`) with командами `status`, `telemetry --stream`, `start-task`, `brake`, `smap`.
- FastAPI backend (`backend/operator/server.py`) с REST/WebSocket API и фоновой рассылкой телеметрии.
- Веб-клиент на Vite + React Router (`frontend/web/`) с графиками и кнопками управления.
- Скрипт `scripts/operator_stack.sh` для пакетного запуска, остановки и перезапуска сервиса.
- Корневой `.gitignore`, исключающий виртуальные окружения, `node_modules`, логи и артефакты рантайма.

### Fixed

- Улучшен дизайн веб‑консоли оператора (`frontend/web/`): восстановлена работа вкладок (telemetry, camera, status, output), исправлен вертикальный/горизонтальный порядок панели действий — теперь кнопки располагаются корректно на горизонтальной панели, исправлены стили и responsive-поведение в `src/style.css`.
- Обновлена логика и небольшие правки JS для стабильного переключения вкладок и управления камерой (`frontend/web/src/main.jsx`).

### Documentation

- Обновлён `docs/deploy-guide.md` (актуальная структура репозитория и инструкции по операторскому стеку).
- Переписан `docs/operator.md` с подробным гайдом по установке и запуску CLI/Web UI.
- `docs/implementation-plan.md` переведён на чекбоксы с фактическим статусом задач.

### Firmware & Camera

- Добавлены модули `camera_http` и `wifi_link`, обеспечивающие HTTP-снимки камеры, контроль стрима и обёртку над Wi-Fi (`camcfg`, `camstream`).
- Обновлён `config.hpp` и `platformio.ini`: конфигурация сети вынесена в макросы, задан дефолт SSID/пароль и флаги сборки ESP32-S3.
- Переписан `main.cpp`: защита автоматизации при отсутствии UNO, вывод Wi-Fi/камеры в `STATUS`, команды `CAMCFG`/`CAMSTREAM`, синхронизация настроек камеры и авто-пинг UNO.
- `i2c_link` получил `i2c_ping_uno`, переиспользуемые хелперы чтения/записи и новые прототипы в `shelf_map.hpp`.
- `vision_color.cpp` настроен под распиновку OV2640 на Freenove ESP32-S3 и корректную инициализацию сенсора.
- CLI `SMAP` переписан на универсальный обработчик (`shelf_map.cpp`) с поддержкой `GET/SET/SAVE/CLEAR`.

### Camera Diagnostics (2025-10-12)

### Added / Changed

- Firmware: snapshot diagnostics — snapshot handler now reports the actual framebuffer size via an `X-Frame-Size` HTTP header and the camera initialization logs the first test frame dimensions. This helps reconcile reported camera resolution with the actual served image.
- Firmware: `vision_color.cpp` updated to log an initial test frame after `esp_camera_fb_get()`; camera initialization iterates candidate frame sizes and sets a `cam_max` that is reported over CLI.
- Backend: diagnostics enriched — `/api/diagnostics` now includes `camera.resolution`, `camera.quality`, `camera.available_resolutions`, and `camera.max_resolution` (fetched from CAMCFG when serial is available). The backend also uses STATUS to determine `camera.snapshot_url` and streaming state.
- Frontend: Camera status card updated to show `Resolution` and `Quality` in the Status tab; camera settings form continues to show available resolutions and quality controls.
- Tooling: added `scripts/operator_serial_bridge.sh` helper to expose a host serial device to Docker via `socat`, and the default `.env` now points `OPERATOR_SERIAL_PORT` at `socket://host.docker.internal:3333` for container workflows on macOS/Windows.

### Logs / Parser (2025-10-12)

- Backend: structured log support — logs are now parsed into structured entries (`timestamp`, `time_iso`, `source`, `device`, `parameter`, `value`, `raw`) and `/api/logs` + `/ws/logs` return `entries` payloads; the server attaches stable `id` values for deduping and ordering.
- Parser: added `backend/operator/log_parser.py` to normalize serial lines into structured records and refined classification rules so unprefixed `key=value` CLI responses are attributed to `esp32/system` while explicit `[UNO]` prefixed lines remain `arduino`.
- Frontend: Logs tab replaced the raw textarea with a searchable, sortable and filterable table; sticky, opaque header and bounded height with internal scrolling were added for better UX; JS now normalizes API/WS structured entries and maintains filter state across updates.
- Tests: unit tests added/updated for the log parser (`backend/operator/tests/test_log_parser.py`).
- Operational: operator stack restarted to pick up parser and web client changes during validation.

### Notes

- The backend forwards the camera snapshot URL and stream state discovered via STATUS; the UI reads diagnostics to populate the Camera card. If the browser cache serves an older JS bundle you may need to hard-reload the page to see the updated card text.

### Operator / Shelf Map (2025-10-12)

- Added Shelf Map support: REST endpoint `/api/shelf-map` with live `GET`/`PUT`/`RESET` operations and a frontend grid editor allowing the operator to view and set the 3x3 colour matrix. (RU: Добавлена поддержка Shelf Map — REST `/api/shelf-map` и UI для редактирования 3x3 матрицы цветов.)
- Fixed backend parsing robustness: SMAP replies can be interleaved with telemetry (e.g. `[TLM]` lines); the server now ignores unrelated key=value fragments and non-grid lines to avoid ValueError/500 responses. (RU: Исправлена устойчивость парсинга SMAP — сервер игнорирует служебные/телеметрийные строки.)
- Operational: reflashed ESP32 firmware and restarted the operator stack to validate SMAP behaviour; verified responses via CLI (`smap get --raw`) and HTTP (`GET /api/shelf-map`). (RU: Перепрошивка ESP32 и перезапуск стека оператора — проверено через CLI и HTTP.)


### Operator Backend & Tooling

- `backend/operator/server.py` расширен REST/WS-эндпоинтами: `/api/camera/config`, `/api/camera/snapshot`, `/api/diagnostics`, `/api/logs`, `/ws/camera`, `/ws/logs`; добавлены опросы статуса камеры, диагностика Wi-Fi и рассылка логов.
- `backend/operator/esp32_link.py` усилил таймауты, отслеживание активного порта и буферизацию логов для стриминга.
- `backend/operator/pyproject.toml` настроен на сборку/установку из корня, унифицирован запуск pytest.
- Скрипт `scripts/operator_stack.sh` подхватывает переменные окружения из `.env`, добавлен шаблон `.env` с параметрами камеры; старые `backend/operator/start_operator_stack.sh` и `stop_operator_stack.sh` удалены как дублирующие.
- Добавлен тест `backend/operator/tests/test_camera_config.py` для проверки конфигурации камеры через API.
- Backend: код FastAPI разбит на пакеты `api/`, `services/`, `models/`; Pydantic-схемы вынесены в отдельный модуль, логика `OperatorService` изолирована от маршрутов, `server.py` теперь служит только точкой входа.
- Tests: добавлен набор `backend/operator/tests/test_api_routes.py`, покрывающий базовые REST сценарии (`/api/status`, `/api/camera/config`, `/api/command`) с использованием заглушки `OperatorService`.
- Docker: добавлены `docker/backend.Dockerfile`, `docker/frontend.Dockerfile`, `docker/frontend.nginx.conf` и `docker-compose.yml` для запуска backend/frontend в контейнерах.
- CLI: добавлен `scripts/operator_stack_docker.sh` для управления контейнерным стеком (`build/start/status/logs/stop/restart`).

### Web UI

- `frontend/web/index.html` получил новые маршруты Settings/Logs, элементы управления стримом и бейдж статуса камеры.
- `frontend/web/src/main.jsx` переработан: модульная инициализация, работа с diagnostics/info, управление стримом, настройка камеры и WebSocket-логами.
- `frontend/web/src/style.css` обновлён стилями для бейджей транспорта камеры, сетки настроек, логов и расширенных карточек статуса.

## [2025-09-01]

### Firmware

- ESP32 `main.cpp` реализует поведенческое дерево Pick→Place с инициализацией камеры, карты склада и I2C-команд на Arduino UNO.
- Библиотека `i2c_link` описывает протокол обмена с UNO: команды привода, лифта, захвата, конфигурацию и чтение телеметрии (`STATUS`, `ODOM`, `LINES`).
- Модуль `shelf_map` хранит раскладку цветов в NVS, поддерживает команды `SMAP get/set/save` через UART CLI.
- `vision_color` обрабатывает данные камеры для определения цвета цилиндра (см. `detect_cylinder_color`).
- Прошивка Arduino UNO (`firmware/src/uno/main.cpp`) управляет сервоприводами, энкодерами, датчиками линии и реализует I2C-регистры ICD 0x00–0x82.
