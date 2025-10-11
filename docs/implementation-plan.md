# Implementation Plan — Operator Web UI & CLI

## Objectives

- Provide an operator-facing interface (terminal & browser) to interact with the ESP32 master controller using the existing UART CLI.
- Surface core telemetry (status, line sensors, odometry) and allow triggering safe control commands (`start`, `brake`, `smap`, configuration sync).
- Keep the solution host-side (Dev PC) without modifying firmware; ensure serial communication is abstracted for reuse.

## Work Breakdown & Status

### 1. Protocol Recon & Abstractions

- [x] Инвентаризировать доступные UART-команды (`status`, `SMAP`, `START`, `BRAKE`) и сформировать минимальный набор для операторов.
- [x] Спроектировать Python-обёртку для последовательного обмена: автопоиск порта, обработка таймаутов, парсинг ответов.

### 2. Shared Serial Service Layer

- [x] Реализовать `tools/operator/esp32_link.py` с управлением сессией, повторными попытками и переиспользуемыми помощниками.
- [x] Возвращать структурированные словари для статусных/телеметрических команд и операций с картой склада.
- [x] Покрыть парсинг примерами в `tests/test_parsing.py`.

### 3. CLI Application

- [x] Собрать `tools/operator/cli.py` на Typer с командами `status`, `telemetry --stream`, `start-task`, `brake`, `smap`-операциями.
- [ ] Добавить команду `cfg sync` и расширенное покрытие аргументов (запланировано после согласования с командой прошивки).
- [x] Настроить базовые тесты для проверки парсинга и интеграции со ссылкой.

### 4. Web API Backend

- [x] Создать `tools/operator/server.py` (FastAPI) с эндпоинтами `GET /api/status`, `POST /api/command`, `WS /ws/telemetry`.
- [x] Организовать фоновые опросы телеметрии и рассылку по подписчикам, обрабатывать разрывы соединения.

### 5. Web Frontend

- [x] Реализовать дашборд (Vite + Chart.js) с живыми графиками и кнопками Start/BRAKE.
- [x] Настроить `pnpm`-зависимости и dev-server с прокси на backend.

### 6. Tooling & Packaging

- [x] Подготовить `pyproject.toml` для установки пакета `rbm-operator-tools` во venv.
- [x] Добавить скрипты `start_operator_stack.sh` и `stop_operator_stack.sh` для запуска стека.

### 7. Documentation & Validation

- [x] Обновить `docs/deploy-guide.md` и `docs/operator.md` с пошаговыми инструкциями.
- [ ] Зафиксировать результаты тестов/ограничения без железа и настроить моковые сценарии (ожидает доступа к аппаратуре).

## Acceptance Criteria

- CLI tool connects to ESP32 UART CLI, executes core commands, and provides structured output/streaming view.
- Web UI displays live telemetry (mocked if hardware unavailable) and executes control commands via REST/WebSocket flows.
- Serial abstraction shared by CLI & server with unit-test coverage for parsing and error handling.
- Documentation updated; instructions for installation and usage are clear; dependencies managed with pnpm (frontend) and pip/pyproject (backend).
- No changes to firmware; solution ready for hardware validation when available.
