@echo off
REM ======================================================
REM  Proizvodstvenny uchet - Windows start (no Docker)
REM  Requires Node.js LTS only: https://nodejs.org
REM ======================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install LTS from https://nodejs.org and run again.
  pause
  exit /b 1
)

REM Absolute DB path - same for prisma CLI and the app runtime
set "DB_DIR=%~dp0db"
if not exist "%DB_DIR%" mkdir "%DB_DIR%"
set "DB_URL_PATH=%DB_DIR:\=/%"
set "DATABASE_URL=file:%DB_URL_PATH%/custom.db"

if not exist node_modules (
  echo Installing dependencies - first run only, takes a few minutes...
  call npm install
  if errorlevel 1 ( echo [ERROR] npm install failed & pause & exit /b 1 )
)

echo Preparing database...
call npx prisma generate
call npx prisma db push --skip-generate
if errorlevel 1 ( echo [ERROR] database setup failed & pause & exit /b 1 )

if not exist ".next\standalone\server.js" (
  echo Building application - first run only, takes a few minutes...
  call npm run build
  if errorlevel 1 ( echo [ERROR] build failed & pause & exit /b 1 )
)

echo.
echo  Site: http://localhost:3000   (Ctrl+C to stop)
echo  From other PCs on the network: http://YOUR-IP:3000
echo.
call npm start
pause
