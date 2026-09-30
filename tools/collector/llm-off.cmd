@echo off
rem Кнопка для LLM: off — лента продолжает строиться; действует со следующего запуска сборщика.
chcp 65001 >nul
py -3 "%~dp0collect.py" --llm off
echo.
pause
