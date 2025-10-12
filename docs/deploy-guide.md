# Полное руководство по проверке и запуску (PlatformIO) — v1.0

> Это пошаговый гайд, как проверить и запустить прошивки **UNO + ESP32‑S3** через **PlatformIO** с учётом твоей электрики (**RBM — Электрика v0.3**: MPS/E‑STOP разрывает только силовую шину MC29; общая земля; I²C с внешними подтяжками к 3.3V; лифт — энкодер, захват — потенциометр).

---

## 0) Что будет на выходе

* Прошитые: **UNO** (исполнитель) и **ESP32‑S3** (ИИ/мастер I²C).
* Проверена шина **I²C** и обмен по **ICD**.
* Демо‑поведение запущено: **без силы** (MPS открыт) и затем **с силой** (MPS закрыт, робот на подставке).
* Включена **визуализация телеметрии** (графики elev/grip/L/R/thr в реальном времени).

---

## 1) Предварительные проверки безопасности (электрика)

1. **MPS/E‑STOP открыт** → моторы обесточены, но UNO/ESP32 получают 5V/USB.
2. Общая **GND**: батарея, UNO, ESP32 соединены «звездой» возле DC/DC.
3. **I²C**: SDA↔SDA, SCL↔SCL, **pull‑up 4.7–10 кОм к 3.3V** (НЕ к 5V). Длина ≤ 40 см.
4. MC29×6: сигнальные 3‑проводные входы (White=SIG, Red=+5V, Black=GND) от UNO; силовые 2‑проводные — от батареи через MPS.
5. Датчики линии: A0/A1; энкодер лифта: D2/D7; потенциометр захвата: A3.

**Stop‑критерии:** любая ошибка разводки/полярности → не прошиваем, сначала исправляем.

---

## 2) PlatformIO: структура проекта и конфиг

### 2.1 Актуальная структура репозитория

```text
ai_drived_robot/
├── docs/
│   ├── deploy-guide.md
│   ├── operator.md
│   ├── implementation-plan.md
│   └── ... (ICD, схемы, архитектурные заметки)
├── firmware/
│   ├── platformio.ini
│   └── src/
│       ├── esp32/
│       │   ├── config.hpp
│       │   ├── i2c_link.cpp / i2c_link.hpp
│       │   ├── shelf_map.cpp / shelf_map.hpp
│       │   ├── vision_color.cpp / vision_color.hpp
│       │   ├── main.cpp (верхнеуровневое поведение)
│       │   ├── include/   (хедеры для PlatformIO)
│       │   └── src/       (дубли для layout PIO)
│       └── uno/
│           └── main.cpp   (прошивка исполнительного контроллера)
├── backend/
│   └── operator/
│       ├── api/ (FastAPI маршруты)
│       ├── services/ (OperatorService + зависимости)
│       ├── models/ (Pydantic-схемы REST/WS)
│       ├── cli.py, esp32_link.py
│       ├── server.py (ASGI entrypoint)
│       ├── pyproject.toml, tests/
│       └── __init__.py
├── docker/
│   ├── backend.Dockerfile
│   ├── frontend.Dockerfile
│   └── frontend.nginx.conf
├── scripts/
│   └── operator_stack.sh     (запуск backend/frontend)
└── frontend/
  └── web/
    ├── package.json, vite.config.js
    ├── src/ (React + React Router UI)
    └── public/
```

> Директория `.venv` для Python и папка `node_modules/` создаются по месту (соответственно в `backend/operator/` и `frontend/web/`) и не входят в репозиторий.

### 2.2 platformio.ini (готовый шаблон)

```ini
[platformio]
default_envs = esp32s3, uno

[env:uno]
platform = atmelavr
board = uno
framework = arduino
upload_speed = 115200
monitor_speed = 115200
lib_deps =
  arduino-libraries/Servo @ ^1.2.1
src_filter = +<uno/> -<*>
monitor_filters = colorize, time
; upload_port = /dev/ttyACM0 ; или COM3
; monitor_port = /dev/ttyACM0

[env:esp32s3]
platform = espressif32
board = esp32-s3-devkitc-1
framework = arduino
upload_speed = 921600
monitor_speed = 115200
build_flags =
  -DARDUINO_USB_MODE=1
  -DARDUINO_USB_CDC_ON_BOOT=1
  ; при необходимости укажите пины I²C
  ; -DI2C_SDA=8
  ; -DI2C_SCL=9
src_filter = +<esp32/> -<*>
monitor_filters = colorize, time
; upload_port = /dev/ttyACM1 ; или COM4
; monitor_port = /dev/ttyACM1
```

> Если у тебя другая ESP32‑S3 плата — замени `board` на актуальную из **PIO Home → Boards**.

---

## 3) Прошивка UNO (исполнитель)

1. Подключи **UNO по USB**.
2. В корне проекта: `pio run -e uno -t upload`.
3. Открой монитор (опц.): `pio device monitor -e uno` (115200).
4. Убедись, что ошибок загрузки нет.

**DoD‑UNO:** прошивка встаёт без ошибок; при открытом MPS сервосигналы на всех MC29 = **1500 µs** (ноль).

---

## 4) Прошивка ESP32‑S3 (мастер I²C)

1. Подключи **ESP32‑S3 по USB**.
2. `pio run -e esp32s3 -t upload`.
3. Открой монитор: `pio device monitor -e esp32s3` (115200). Должно появиться: `ESP32 RBM master started`.
4. Если порт «занят» — закрой старый монитор и повтори загрузку.

**DoD‑ESP32:** прошивка грузится, порт стабилен, стартовая строка видна.

---

## 5) Проверка обмена по I²C (MPS открыт — без силы)

1. Оставь **MPS открытым** (моторы обесточены). UNO и ESP32 запитаны от USB.
2. ESP32 раз в ~25 мс читает `STATUS` с UNO. В мониторе смотри строки `ERR=0x0000`.
3. При `ERR_I2C`/`ERR_TIMEOUT` проверь: SDA/SCL, pull‑up к 3.3V, общий GND, адрес `0x12`.

**DoD‑I²C:** ошибок нет, обмен стабильный.

---

## 6) Первый прогон демо‑поведения (всё ещё без силы)

* В демо‑BT ESP32 пошлёт: `BRAKE off → HOME (лифт/захват) → GRIP OPEN → DRIVE(200,0,0,300ms) → GRIP CLOSE → ELEV 100mm`.
* Силы нет (MPS открыт), механика не двигается, но **сервосигналы** меняются. Это видно по телеметрии и осциллографом/логическим тестером.

**DoD‑Demo‑Dry:** цикл проходит, ошибок нет.

---

## 7) «Полусухой» тест (с силой, но безопасно)

1. Подними робот на подставки (колёса в воздухе).
2. **Закрой MPS** — подай силу на MC29.
3. Запусти демо‑цикл ещё раз. Колёса мягко провернутся, лифт/захват отработают.
4. Нажми **аппаратный E‑STOP/MPS** — все 6 каналов должны мгновенно встать в **1500 µs**.

**DoD‑Demo‑Power:** приводы реагируют корректно, E‑STOP работает.

---

## 8) Визуализация телеметрии (реал‑тайм графики)

### 8.1 Включи CSV‑лог на ESP32

В `src/esp32/main.cpp` рядом с чтением `STATUS` добавь печать:

```cpp
uint8_t s1[4], ln[6];
if(link.readBlock(0x44, s1, sizeof(s1)) && link.readBlock(0x48, ln, sizeof(ln))){
  int16_t elev = (int16_t)(s1[0] | (s1[1]<<8));
  int16_t grip = (int16_t)(s1[2] | (s1[3]<<8));
  uint16_t L = (uint16_t)(ln[0] | (ln[1]<<8));
  uint16_t R = (uint16_t)(ln[2] | (ln[3]<<8));
  uint16_t thr = (uint16_t)(ln[4] | (ln[5]<<8));
  Serial.printf("elev=%d,grip=%d,L=%u,R=%u,thr=%u\n", elev, grip, L, R, thr);
}
```

### 8.2 Скрипт `tools/plot_telemetry.py`

```bash
python tools/plot_telemetry.py <PORT_ESP32>
```

Появятся графики `elev, grip, L, R, thr` в реальном времени (Matplotlib). Для записи в лог: `pio device monitor -e esp32s3 --log logs/esp32.log`.

---

## 9) Мини‑калибровки перед выездом

* **Лифт:** в `src/uno/config.h` выставь `enc_per_mm` и уровни `h1/h2/h3`. Пересобери `-e uno`.
* **Захват:** в `config.h` подгони `pot_min/max` и `deg_min/max` (смотри телеметрию `pot_raw` и `grip_pos_deg`).
* **Линия:** автопорог по умолчанию; если нужно — задай `cfg_line_thr` явно.
* **Камера:** (позже) баланс белого/экспозиция, калибровка px→мм.

---

## 10) Частые проблемы и быстрые решения

* **Нет связи I²C** → нет общих GND/подтяжек к 3.3V; длинные провода; неправильный адрес; занятость порта монитором при аплоаде.
* **Колёса «назад‑вперёд» перепутаны** → поменяй полярность на клеммах 393 или инвертируй знаки в `mecanum.h`.
* **Лифт дрожит** → уменьшай PD‑коэффициенты в `liftControlUS()`; проверь трение/люфт.
* **Захват не держит** → увеличь `Kp` в `gripControlUS()`; точно выставь `pot_min/pot_max`.

---

## 11) Чек‑листы готовности

### Перед стендовым тестом

* [ ] MPS открыт; USB на оба контроллера.
* [ ] UNO и ESP32 прошиты через PIO; мониторы открываются.
* [ ] I²C: `ERR=0x0000` стабильно ≥ 30 сек.

### Перед «полусухим» тестом

* [ ] Робот на подставке; MPS закрыт.
* [ ] Демо‑цикл отрабатывает; E‑STOP мгновенно останавливает.

### Перед полевым прогоном

* [ ] Калибровки лифта/захвата/линии зафиксированы.
* [ ] Телеметрия визуализируется; логи пишутся (опц.).
* [ ] Поле чистое; датчики на высоте 3–5 мм; батарея заряжена.

---

## 12) Приложение A — Быстрые команды PIO

```bash
# Сборка/прошивка
pio run -e uno -t upload
pio run -e esp32s3 -t upload

# Мониторы
pio device monitor -e uno
pio device monitor -e esp32s3

# Порты (если нужно)
pio device list
# или зафиксируй upload_port/monitor_port в platformio.ini
```

---

Готово. Следующий шаг — (1) пройти весь раздел 1–7 один‑в‑один, (2) включить визуализацию по §8, (3) подогнать калибровки по §9 и только потом ехать на поле. Если нужно — добавлю отдельный раздел с веб‑дашбордом (ESP32‑CAM MJPEG + статус‑оверлей).

---

## 13) Операторский интерфейс (CLI + Web UI)

Каталоги `backend/operator/` и `frontend/web/` содержат полностью автономный стек для взаимодействия с ESP32:

* **CLI (`rbm-operator`)** — позволяет опрашивать статус, подписываться на телеметрию, выполнять команду BRAKE и управлять картой склада.
* **FastAPI-шлюз (`rbm-operator-server`)** — обеспечивает REST/WebSocket доступ к UART.
* **Web UI (`frontend/web`)** — дашборд на Vite + React с графиками и управляющими кнопками.

Рекомендуемый порядок запуска:

```bash
./scripts/operator_stack.sh start      # поднимает backend и фронтенд

# После работы
./scripts/operator_stack.sh stop
# Статус и перезапуск при необходимости
./scripts/operator_stack.sh status
./scripts/operator_stack.sh restart
```

Сценарий автоматически использует виртуальное окружение (`backend/operator/.venv`) и проверяет наличие `node_modules`. Если нужно запустить вручную — следуйте руководству `docs/operator.md` (разделы 2–7).

### 13.1) Запуск в Docker

Полностью контейнеризованный сценарий доступен через `docker-compose.yml` в корне:

```bash
docker compose up --build
```

Команда собирает `docker/backend.Dockerfile` (uvicorn на `0.0.0.0:8000`) и `docker/frontend.Dockerfile` (Vite build + nginx, публикующийся на `5173`). Nginx пробрасывает `/api` и `/ws` в сервис `backend`, поэтому веб-клиент продолжает работать с относительными путями. Переменные окружения подхватываются из `.env`.

Для остановки выполните `docker compose down`. После изменения исходников перезапустите `docker compose up --build` или предварительно `docker compose build`.

CLI-обёртка `./scripts/operator_stack_docker.sh` объединяет типовые команды (`build`, `start`, `status`, `logs`, `stop`, `restart`).
