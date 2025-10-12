# Операторский набор инструментов (CLI + Web UI)

Руководство описывает установку и эксплуатацию инструментов в каталоге `tools/operator`, которые позволяют управлять ESP32 через UART CLI и получать телеметрию в виде терминальной утилиты и веб‑панели.

## 1. Требования

- Python 3.10 или новее.
- Node.js 18+ и пакетный менеджер `pnpm` (устанавливается командой `npm install -g pnpm`).
- Доступ к ESP32, подключённой по USB и предоставляющей UART CLI согласно документу ICD.

## 2. Подготовка Python-окружения

```bash
cd tools/operator
python -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -U pip
pip install -e .
```

После установки в режиме editable становятся доступны консольные точки входа:

- `rbm-operator` — командная утилита для работы с UART CLI.
- `rbm-operator-server` — FastAPI-шлюз (по умолчанию порт 8000).

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
   source tools/operator/.venv/bin/activate
   rbm-operator-server
   ```

2. В отдельном терминале установите зависимости и поднимите Vite:

   ```bash
    cd tools/operator/web
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

Для одновременного запуска backend и frontend используйте вспомогательные скрипты:

```bash
cd tools/operator
./start_operator_stack.sh   # стартует uvicorn + Vite

# ... работа ...

./stop_operator_stack.sh    # мягкая остановка обоих процессов
```

Скрипт `start_operator_stack.sh` проверяет наличие виртуального окружения и каталога `node_modules`, запускает сервер через `python -m tools.operator.server`, прокидывая `PYTHONPATH`. Логи сохраняются в `.operator_runtime/backend.log` и `.operator_runtime/frontend.log`. При повторном вызове выполняется проверка PID, чтобы избежать дублей.

## 6. Валидация

- Unit-тесты парсеров: `source .venv/bin/activate && python -m pytest` в каталоге `tools/operator`.
- Проверка «железом»: выполнить `rbm-operator status`, убедиться в появлении структурированных данных и отсутствии ошибок CLI; в веб‑интерфейсе убедиться, что подписка `/ws/telemetry` передает обновления.
- Перед полевыми испытаниями повторить чек-листы из `docs/deploy-guide.md` (разделы 6–11) и проверить работу BRAKE.

## 7. Частые проблемы

- **Не найден порт** — укажите `--port` и убедитесь в установке драйверов CP210/CH340.
- **Нет pyserial** — активируйте виртуальное окружение и повторите `pip install -e .`.
- **WebSocket не подключается** — проверьте, что backend слушает порт 8000, а брандмауэр не блокирует localhost.
- **Пустые метрики** — CLI должен выводить пары `ключ=значение`. Настройте прошивку или адаптируйте `METRIC_CONFIG` в `web/src/main.js`.
