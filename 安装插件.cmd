@echo off
rem Install this folder as the DSH plugin dsh-desktop-boot-splash.
rem Keep this file pure ASCII on purpose: cmd.exe mis-reads non-ASCII batch files.
rem All Chinese messages live in install-plugin.ps1 (UTF-8 with BOM).
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-plugin.ps1" %*
echo.
pause
