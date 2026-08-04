#!/bin/sh
# Производственный учёт — запуск на Linux/Mac без Docker.
# Требуется только Node.js LTS (https://nodejs.org).
cd "$(dirname "$0")" || exit 1

command -v node >/dev/null 2>&1 || {
  echo "[ОШИБКА] Node.js не найден — установите LTS с https://nodejs.org"; exit 1;
}

# Абсолютный путь к базе — одинаков для prisma CLI и рантайма приложения
mkdir -p db
DATABASE_URL="file:$(pwd)/db/custom.db"
export DATABASE_URL

[ -d node_modules ] || { echo "Установка зависимостей (один раз)..."; npm install || exit 1; }

echo "Подготовка базы данных..."
npx prisma generate && npx prisma db push --skip-generate || exit 1

if [ ! -f .next/standalone/server.js ]; then
  echo "Сборка приложения (один раз)..."
  npm run build || exit 1
fi

echo
echo "  Сайт: http://localhost:3000   (Ctrl+C — остановить)"
echo
exec npm start
