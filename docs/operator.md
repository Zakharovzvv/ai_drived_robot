# Операторский набор инструментов (CLI + Web UI)

Руководство описывает установку и эксплуатацию инструментов в каталогах `backend/operator` и `frontend/web`, которые позволяют управлять ESP32 через UART CLI и получать телеметрию в виде терминальной утилиты и веб‑панели.

## 1. Требования

- Python 3.10 или новее.
- Node.js 18+ и пакетный менеджер `pnpm` (устанавливается командой `npm install -g pnpm`).
- Доступ к ESP32, подключённой по USB и предоставляющей UART CLI согласно документу ICD.

## 2. Подготовка Python-окружения

```bash
cd backend/operator
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -U pip
pip install -e .
```

После установки в режиме editable становятся доступны консольные точки входа:

- `rbm-operator` — командная утилита для работы с UART CLI.
- `rbm-operator-server` — FastAPI-шлюз (по умолчанию порт 8000).

### Структура модулей backend

- `backend/operator/server.py` — тонкий ASGI-вход, подключающий маршруты и жизненный цикл.
- `backend/operator/api/routes.py` — HTTP/WS-эндпоинты FastAPI, построенные на зависимостях.
- `backend/operator/services/operator_service.py` — бизнес-логика, работа с ESP32 и кэшами.
- `backend/operator/models/api.py` — Pydantic-схемы запросов и ответов для согласования с фронтендом.
- `backend/operator/services/dependencies.py` — единая точка создания/остановки `OperatorService` для DI.

## 3. Использование CLI

Примеры базовых команд:

```bash
# Разовый запрос статуса (автоопределение порта)
rbm-operator status

# Потоковая телеметрия (кадр STATUS каждые 0.5 с)
rbm-operator telemetry --interval 0.5

# Немедленный перевод приводов в безопасное состояние
rbm-operator brake

# Управление картой склада
rbm-operator smap get
rbm-operator smap set "R,G,B; Y,W,K; -,-,-"
rbm-operator smap save
```

Часто используемые опции:

- `--port` — явный путь к последовательному порту (например `/dev/ttyUSB0`, `COM5`).
- `--baudrate` — скорость UART, по умолчанию `115200`.
- `--raw` — вывести оригинальные строки CLI без JSON-преобразования.

## 4. Веб-интерфейс

1. Запустите backend (если не используется стартовый скрипт):

   ```bash
   source backend/operator/.venv/bin/activate
   rbm-operator-server
   ```

2. В отдельном терминале установите зависимости и поднимите Vite:

   ```bash
   cd frontend/web
    pnpm install          # однократно
    pnpm run dev          # dev-сервер http://localhost:5173
   ```

   Proxy маршрутизирует запросы `/api` и `/ws` на `http://localhost:8000`. Для продакшен-сборки выполните `pnpm run build` и разместите содержимое `dist/` на сервере или настройте раздачу статических файлов в FastAPI.

3. Откройте `http://localhost:5173`. Дашборд отображает:

   - карточки статуса с ключевыми метриками `STATUS`;
   - live-график (лифт, захват, датчики линии, напряжение батареи);
   - кнопки управления (Start, BRAKE, произвольные команды).
   - вкладку Settings с редактором Shelf Map для конфигурации 3×3 матрицы цветов прямо с UI.

## 5. Автоматический запуск и остановка

Для одновременного запуска backend и frontend используйте единый скрипт в корне репозитория:

```bash
./scripts/operator_stack.sh start     # стартует uvicorn + Vite

# ... работа ...

./scripts/operator_stack.sh stop      # мягкая остановка обоих процессов
./scripts/operator_stack.sh status    # проверка PID и путей к логам
./scripts/operator_stack.sh restart   # последовательная остановка и запуск
```

Скрипт проверяет наличие виртуального окружения и каталога `node_modules`, запускает сервер через `python -m backend.operator.server`, прокидывая `PYTHONPATH`, и сохраняет логи в `.operator_runtime/backend.log` и `.operator_runtime/frontend.log`. При повторном вызове выполняется проверка PID, чтобы избежать дублей.

## 6. Валидация

- Unit-тесты парсеров: `source .venv/bin/activate && python -m pytest` в каталоге `backend/operator`.
- Проверка «железом»: выполнить `rbm-operator status`, убедиться в появлении структурированных данных и отсутствии ошибок CLI; в веб‑интерфейсе убедиться, что подписка `/ws/telemetry` передает обновления.
- Перед полевыми испытаниями повторить чек-листы из `docs/deploy-guide.md` (разделы 6–11) и проверить работу BRAKE.

## 7. Контейнеризация (Docker)

Для запуска стека в Docker подготовлены отдельные контейнеры:

- `docker/backend.Dockerfile` — Python 3.13 образ с установленным `rbm-operator` и запуском `uvicorn` на порту 8000.
- `docker/frontend.Dockerfile` — многостадийная сборка: `pnpm build` статики и nginx с проксированием `/api` и `/ws` на backend.

Файл `docker-compose.yml` в корне стартует оба сервиса командой:

```bash
docker compose up --build
```

Порты по умолчанию: backend `8000`, frontend `5173` (обёртка над nginx:80). Для изменения настроек обновите `docker-compose.yml` или передайте переменные окружения в `.env`.

Для связи с ESP32 из контейнера задайте `OPERATOR_SERIAL_PORT` в `.env`. Значение может указывать на физическое устройство (`/dev/ttyUSB0`) при запуске на Linux с пробросом через `--device`, либо на TCP-прокси в формате `socket://host.docker.internal:3333`. На macOS/Windows удобнее поднять локальный мост (используя `socat`) и прокинуть порт в Docker:

```bash
brew install socat  # macOS
./scripts/operator_serial_bridge.sh /dev/cu.usbmodem1101 3333
```

Мост работает до нажатия Ctrl+C. После запуска убедитесь, что в `.env` прописано `OPERATOR_SERIAL_PORT=socket://host.docker.internal:3333`, затем перезапустите стек (`./scripts/operator_stack_docker.sh restart`).

Для удобства добавлен хелпер `scripts/operator_stack_docker.sh`:

```bash
./scripts/operator_stack_docker.sh build    # собрать/обновить образы
./scripts/operator_stack_docker.sh start    # поднять стек (detached)
./scripts/operator_stack_docker.sh status   # показать состояние контейнеров
./scripts/operator_stack_docker.sh logs     # общие логи (Ctrl+C для выхода)
./scripts/operator_stack_docker.sh stop     # остановить и удалить
```

## 8. Частые проблемы

- **Не найден порт** — укажите `--port` и убедитесь в установке драйверов CP210/CH340.
- **Docker не видит ESP32** — пробросьте устройство (`--device /dev/ttyUSB0`) или поднимите TCP-мост (см. пример с `socat`) и настройте `OPERATOR_SERIAL_PORT`.
- **Нет pyserial** — активируйте виртуальное окружение и повторите `pip install -e .`.
- **WebSocket не подключается** — проверьте, что backend слушает порт 8000, а брандмауэр не блокирует localhost.
- **Пустые метрики** — CLI должен выводить пары `ключ=значение`. Настройте прошивку или адаптируйте `METRIC_CONFIG` в `frontend/web/src/constants.js`.
