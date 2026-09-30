@echo off
chcp 65001 >nul
py -3 "%~dp0collect.py" --llm status
echo.
pause
