# Собирает образ Точки сбора: зависимости/сборка на хосте, затем docker.
# Использование: из корня репо —  powershell -File uchet/build-docker.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host '== npm install =='
npm install --legacy-peer-deps --no-audit --no-fund

Write-Host '== prisma generate + db template =='
New-Item -ItemType Directory -Force -Path db-template | Out-Null
$abs = (Resolve-Path .).Path -replace '\\', '/'
$env:DATABASE_URL = "file:$abs/db-template/custom.db"
npx prisma generate
npx prisma db push --skip-generate --accept-data-loss

Write-Host '== next build =='
npm run build

Write-Host '== docker compose build/up uchet =='
Set-Location (Split-Path -Parent $root)
docker compose build uchet
docker compose up -d uchet
docker compose ps
