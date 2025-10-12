# Changelog

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

### Firmware & Camera

- Добавлены модули `camera_http` и `wifi_link`, обеспечивающие HTTP-снимки камеры, контроль стрима и обёртку над Wi-Fi (`camcfg`, `camstream`).
- Обновлён `config.hpp` и `platformio.ini`: конфигурация сети вынесена в макросы, задан дефолт SSID/пароль и флаги сборки ESP32-S3.
- Переписан `main.cpp`: защита автоматизации при отсутствии UNO, вывод Wi-Fi/камеры в `STATUS`, команды `CAMCFG`/`CAMSTREAM`, синхронизация настроек камеры и авто-пинг UNO.
- `i2c_link` получил `i2c_ping_uno`, переиспользуемые хелперы чтения/записи и новые прототипы в `shelf_map.hpp`.
- `vision_color.cpp` настроен под распиновку OV2640 на Freenove ESP32-S3 и корректную инициализацию сенсора.
- CLI `SMAP` переписан на универсальный обработчик (`shelf_map.cpp`) с поддержкой `GET/SET/SAVE/CLEAR`.
### [2025-10-12]

### Added / Changed

- Firmware: snapshot diagnostics — snapshot handler now reports the actual framebuffer size via an `X-Frame-Size` HTTP header and the camera initialization logs the first test frame dimensions. This helps reconcile reported camera resolution with the actual served image.
- Firmware: `vision_color.cpp` updated to log an initial test frame after `esp_camera_fb_get()`; camera initialization iterates candidate frame sizes and sets a `cam_max` that is reported over CLI.
- Backend: diagnostics enriched — `/api/diagnostics` now includes `camera.resolution`, `camera.quality`, `camera.available_resolutions`, and `camera.max_resolution` (fetched from CAMCFG when serial is available). The backend also uses STATUS to determine `camera.snapshot_url` and streaming state.
- Frontend: Camera status card updated to show `Resolution` and `Quality` in the Status tab; camera settings form continues to show available resolutions and quality controls.

### Notes

- The backend forwards the camera snapshot URL and stream state discovered via STATUS; the UI reads diagnostics to populate the Camera card. If the browser cache serves an older JS bundle you may need to hard-reload the page to see the updated card text.

### Operator Backend & Tooling

- `tools/operator/server.py` расширен REST/WS-эндпоинтами: `/api/camera/config`, `/api/camera/snapshot`, `/api/diagnostics`, `/api/logs`, `/ws/camera`, `/ws/logs`; добавлены опросы статуса камеры, диагностика Wi-Fi и рассылка логов.
- `tools/operator/esp32_link.py` усилил таймауты, отслеживание активного порта и буферизацию логов для стриминга.
- `tools/operator/pyproject.toml` настроен на сборку/установку из корня, унифицирован запуск pytest.
- Скрипт `start_operator_stack.sh` подхватывает переменные окружения из `.env`, добавлен шаблон `.env` с параметрами камеры.
- Добавлен тест `tools/operator/tests/test_camera_config.py` для проверки конфигурации камеры через API.

### Web UI

- `tools/operator/web/index.html` получил новые вкладки Settings/Logs, элементы управления стримом и бейдж статуса камеры.
- `tools/operator/web/src/main.js` переработан: модульная инициализация, работа с diagnostics/info, управление стримом, настройка камеры и WebSocket-логами.
- `tools/operator/web/src/style.css` обновлён стилями для бейджей транспорта камеры, сетки настроек, логов и расширенных карточек статуса.

## [2025-09-01]

### Firmware

- ESP32 `main.cpp` реализует поведенческое дерево Pick→Place с инициализацией камеры, карты склада и I2C-команд на Arduino UNO.
- Библиотека `i2c_link` описывает протокол обмена с UNO: команды привода, лифта, захвата, конфигурацию и чтение телеметрии (`STATUS`, `ODOM`, `LINES`).
- Модуль `shelf_map` хранит раскладку цветов в NVS, поддерживает команды `SMAP get/set/save` через UART CLI.
- `vision_color` обрабатывает данные камеры для определения цвета цилиндра (см. `detect_cylinder_color`).
- Прошивка Arduino UNO (`firmware/src/uno/main.cpp`) управляет сервоприводами, энкодерами, датчиками линии и реализует I2C-регистры ICD 0x00–0x82.
