#!/bin/sh
# Запуск в Docker с пер-установочными секретами.
# При первом запуске генерирует случайные секреты в .env.compose
# (файл не попадает в git) и поднимает docker compose с ними.
set -e
cd "$(dirname "$0")"
if [ ! -f .env.compose ]; then
  rand() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  {
    echo "ONLYOFFICE_JWT_SECRET=$(rand)"
    echo "AUTH_SECRET=$(rand)"
  } > .env.compose
  echo "Сгенерированы секреты: .env.compose"
fi
exec docker compose --env-file .env.compose up -d --build "$@"
