@echo off
REM Запуск LocalChat (:3780) + Точка сбора / uchet (:3000)
cd /d "%~dp0"

start "LocalChat server" cmd /k "cd /d %~dp0server && npm run dev"
timeout /t 2 /nobreak >nul
start "LocalChat client" cmd /k "cd /d %~dp0client && npm run dev"
timeout /t 1 /nobreak >nul
start "Uchet (Точка сбора)" cmd /k "cd /d %~dp0uchet && npm run dev"

echo Started: chat server, Vite client, uchet on :3000
echo Open http://localhost:5173 and group tab "Точка сбора"
pause
