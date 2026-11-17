@echo off
rem Double-click to install or update aihub. Pass -Next, -Uninstall or -WhatIf to change what it does.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
