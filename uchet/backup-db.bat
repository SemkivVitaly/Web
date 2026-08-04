@echo off
rem Manual / scheduled SQLite backup. ASCII only.
cd /d "%~dp0"
node scripts\backup-db.mjs
