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

## Архив удалённых чатов и правок (для администратора сервера)

Клиентам эти данные не отдаются. Они лежат на диске сервера в каталоге:

```text
server/data/archives/
  groups/
    group-<id>-<name>-<timestamp>/
      manifest.json          — метаданные группы, кто удалил, счётчики
      members.json           — участники и роли
      messages.json          — все сообщения (текст, реакции, упоминания)
      audit-log.json         — журнал аудита группы
      announcements.json     — уведомления/назначения
      tasks-summary.json     — доски и задачи (кратко)
      collab-folders.json    — папки вкладки «Документы»
      collab-documents.json  — метаданные документов + пути к файлам
      files/                 — копии вложений из uploads/
      documents/             — .docx/.xlsx OnlyOffice и *.ystate.bin
  directs/
    direct-<id>/
      index.json             — список событий
      events/
        <timestamp>-message_edit.json
        <timestamp>-message_delete.json
        …
      files/                 — копии вложений из событий
```

### Когда пишется архив

| Событие | Что сохраняется |
|---------|-----------------|
| Удаление группы создателем | Полный снимок группы **до** удаления из БД |
| Очистка истории группы | Сообщения, которые удаляются |
| Удаление сообщения в группе | Снимок этого сообщения |
| Правка сообщения в личке | Старый текст + новое тело (`previousBody` / `newBody`) |
| Удаление сообщения в личке | Полный снимок сообщения и вложений |
| «Убрать чат» + удалить свои сообщения | Все свои сообщения лички |
| Очистка своих сообщений в личке | То же |

В полном архиве группы также сохраняются:
- `documents/` — файлы вкладки «Документы» (`.docx` / `.xlsx` из OnlyOffice и `*.ystate.bin` для richtext/spreadsheet);
- `collab-folders.json` / `collab-documents.json` — структура папок и метаданные.

Каталог `data/archives/` **не удаляется** orphan-cleanup (он чистит только файлы в `uploads/`).

При запуске через Docker Compose данные монтируются в папки проекта:
- `server/data/` — БД, `collab-office-files/`, `archives/`
- `server/uploads/` — вложения чата

Восстановление — вручную: открыть JSON, при необходимости скопировать файлы из `files/` / `documents/` обратно и/или импортировать данные в БД.
