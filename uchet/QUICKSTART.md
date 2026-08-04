# 🚀 Система Управления Актами - Light Version

## 📋 Информация

| Параметр | Значение |
|----------|----------|
| **Название** | Act Management System (Light) |
| **Стек** | Next.js 16 + TypeScript + Prisma + SQLite |
| **Порт** | 3000 |
| **Версия** | Light 1.0 |

---

## ⚡ Быстрый запуск

### Локально (для демонстрации)
```bash
cd acts

# 1. Установить зависимости
bun install

# 2. Инициализировать БД
bun run db:push

# 3. Собрать (production - стабильнее!)
bun run build

# 4. Запустить
bun run start
# или: npx next start -p 3000
```

### Через Docker
```bash
cd acts

docker-compose up -d --build

# Логи:
docker-compose logs -f
```

---

## ✅ РАБОЧИЕ ФУНКЦИИ

### 1. Приёмка изделия
- **Авто-номер:** Оставьте поле "Номер" пустым → `ACT-XXX`
- **Ручной номер:** Введите свой номер → `MY-CODE-001`
- **Обязательные поля:** Источник, Количество

### 2. Изменение статуса
- Выберите акт в вкладке "Изменить"
- Выберите поле "Статус"
- Нажмите "Сохранить"

### 3. Отгрузка
- Выберите акт (только со статусом не "Отгружено" и не "Брак")
- Заполните данные сотрудника
- Нажмите "Создать отгрузку"
- Статус акта автоматически → "shipped"

### 4. Экспорт CSV
- Кнопка "CSV" в вкладке Обзор

---

## 🔌 API Endpoints

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/acts` | Получить все акты |
| POST | `/api/acts` | Создать акт |
| PUT | `/api/acts/[id]` | Обновить акт |
| DELETE | `/api/acts/[id]` | Удалить акт |
| GET | `/api/shipments` | Получить отгрузки |
| POST | `/api/shipments` | Создать отгрузку |
| GET | `/api/products` | Продукция |
| GET | `/api/logs?limit=50` | Лог действий |

### Примеры API вызовов:

```bash
# Создать акт с авто-номером
curl -X POST http://localhost:3000/api/acts \
  -H "Content-Type: application/json" \
  -d '{"actDate":"2025-01-15","actTime":"10:00","actType":"warehouse","quantity":"10"}'

# Создать акт с ручным номером
curl -X POST http://localhost:3000/api/acts \
  -H "Content-Type: application/json" \
  -d '{"actNumber":"CUSTOM-001","actDate":"2025-01-15","actTime":"10:00","actType":"production","quantity":"5"}'

# Сменить статус
curl -X PUT http://localhost:3000/api/acts/{ID} \
  -H "Content-Type: application/json" \
  -d '{"status":"ok"}'

# Создать отгрузку
curl -X POST http://localhost:3000/api/shipments \
  -H "Content-Type: application/json" \
  -d '{"actId":"{ACT_ID}","employeeName":"Иванов И.И."}'
```

---

## 🎨 Light Version - что убрано

Для стабильности из полной версии удалены:

❌ Тяжёлые анимации (Framer Motion particles)
❌ Сложные графики (Recharts)
❌ File-logger (вызвал падения)
❌ Hydration-проблемные компоненты
✅ Оставлено: базовый UI, все функции, стабильность

---

## 🐛 Решение проблем

### Сервер упал:
```bash
pkill -f next; bun run build && bun run start
```

### Ошибка БД:
```bash
bun run db:push
```

---

## 📁 Структура

```
acts/
├── src/app/
│   ├── page.tsx          # Light UI (~600 строк vs 8000+)
│   └── api/
│       ├── acts/route.ts      # CRUD актов
│       ├── acts/[id]/route.ts # Обновление/удаление
│       ├── shipments/route.ts # Отгрузки
│       └── ...
├── prisma/schema.prisma     # БД схема
├── Dockerfile               # Docker конфиг
└── docker-compose.yml       # Compose конфиг
```

---

*Light Version - функциональность прежде всего!*
