# Резервное копирование и мониторинг

## Бэкап БД и файлов

На машине, где запущен сервер:

```bash
cd server
npm run backup
```

Создаётся каталог `server/data/backups/<дата-время>/` с копией `localchat.db` (или файла из `SQLITE_PATH`) и подкаталогом `uploads/` (если он есть).

Рекомендуется вызывать по расписанию (Планировщик заданий Windows, cron на Linux) и хранить копии на другом диске.

### Пример: каждую пятницу в 21:00

#### Windows (Планировщик заданий)

1. **Win + R** → `taskschd.msc` → **Создать задачу…** (не «простую»).
2. **Общие:** имя, например `LocalChat backup`; включить «Выполнять для всех пользователей» / «С наивысшими правами», если каталоги требуют прав администратора.
3. **Триггеры → Создать:** еженедельно, день **пятница**, время **21:00:00**.
4. **Действия → Создать:** «Запуск программы».
   - **Программа:** `cmd.exe`
   - **Аргументы** (подставьте свой путь к проекту):

     ```text
     /c cd /d C:\Users\vital\source\repos\LocalChat\server && npm run backup
     ```

   Либо без `cmd`, указав Node и скрипт напрямую (путь к `node.exe` проверьте командой `where node`):

   - **Программа:** `C:\Program Files\nodejs\node.exe`
   - **Аргументы:** `scripts\backup.mjs`
   - **Рабочая папка:** `C:\Users\vital\source\repos\LocalChat\server`

5. Если БД не в стандартном месте, в том же окне задачи: **Действия** не задают переменные — добавьте в **Общие → Дополнительно** или создайте обёртку `.cmd`, где перед запуском выполните `set SQLITE_PATH=D:\data\localchat.db`.

Проверка: в библиотеке планировщика — правый клик по задаче → **Выполнить**; должен появиться каталог `server\data\backups\<метка-времени>\`.

#### Linux / macOS (cron)

В crontab пользователя, под которым крутится сервер (или root), строка **пятница = 5** (в классическом cron 0 = воскресенье):

```cron
0 21 * * 5 cd /path/to/LocalChat/server && /usr/bin/npm run backup >> /var/log/localchat-backup.log 2>&1
```

Путь к `npm` уточните: `which npm`. При необходимости:

```cron
0 21 * * 5 cd /path/to/LocalChat/server && SQLITE_PATH=/var/lib/localchat.db /usr/bin/npm run backup >> /var/log/localchat-backup.log 2>&1
```

## Мониторинг «живости» сервера

Публичные эндпоинты (без авторизации):

- `GET /api/public/ping` — `{ ok, name }`
- `GET /api/public/health` — проверка SQLite (`SELECT 1`), наличие каталога uploads, аптайм и `rssBytes`

Пример:

```bash
curl -s http://127.0.0.1:3780/api/public/health
```

При ошибке БД ответ **503** и `ok: false`.

Можно подключить к внешнему мониторингу (Uptime Kuma, Zabbix и т.д.) по URL health.
