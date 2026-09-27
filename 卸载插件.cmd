@echo off
rem Remove the DSH plugin dsh-desktop-boot-splash from the desktop profile.
rem Keep this file pure ASCII: cmd.exe mis-reads non-ASCII batch files.
rem Full instructions are in README.md / the quick-start document.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-plugin.ps1" -Remove
echo.
pause
