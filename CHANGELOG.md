# Changelog

## [2025-09-01]

### Firmware

- ESP32 `main.cpp` реализует поведенческое дерево Pick→Place с инициализацией камеры, карты склада и I2C-команд на Arduino UNO.
- Библиотека `i2c_link` описывает протокол обмена с UNO: команды привода, лифта, захвата, конфигурацию и чтение телеметрии (`STATUS`, `ODOM`, `LINES`).
- Модуль `shelf_map` хранит раскладку цветов в NVS, поддерживает команды `SMAP get/set/save` через UART CLI.
- `vision_color` обрабатывает данные камеры для определения цвета цилиндра (см. `detect_cylinder_color`).
- Прошивка Arduino UNO (`firmware/src/uno/main.cpp`) управляет сервоприводами, энкодерами, датчиками линии и реализует I2C-регистры ICD 0x00–0x82.

## [2025-10-11]

### Added

- Operator CLI (`tools/operator/cli.py`) with командами `status`, `telemetry --stream`, `start-task`, `brake`, `smap`.
- FastAPI backend (`tools/operator/server.py`) с REST/WebSocket API и фоновой рассылкой телеметрии.
- Веб-клиент на Vite + Chart.js (`tools/operator/web/`) с графиками и кнопками управления.
- Скрипты `start_operator_stack.sh` и `stop_operator_stack.sh` для пакетного запуска и остановки сервиса.
- Корневой `.gitignore`, исключающий виртуальные окружения, `node_modules`, логи и артефакты рантайма.

### Fixed

- Улучшен дизайн веб‑консоли оператора (`tools/operator/web/`): восстановлена работа вкладок (telemetry, camera, status, output), исправлен вертикальный/горизонтальный порядок панели действий — теперь кнопки располагаются корректно на горизонтальной панели, исправлены стили и responsive-поведение в `src/style.css`.
- Обновлена логика и небольшие правки JS для стабильного переключения вкладок и управления камерой (`tools/operator/web/src/main.js`).

### Documentation

- Обновлён `docs/deploy-guide.md` (актуальная структура репозитория и инструкции по операторскому стеку).
- Переписан `docs/operator.md` с подробным гайдом по установке и запуску CLI/Web UI.
- `docs/implementation-plan.md` переведён на чекбоксы с фактическим статусом задач.
