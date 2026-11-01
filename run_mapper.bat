@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ---- Python
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    echo [check] Python не найден. Установите Python 3.11+ с python.org и отметьте "Add python.exe to PATH".
    goto :fail
)

rem ---- packages
%PY% -m ss14map.check deps
if errorlevel 1 (
    choice /c YN /m "Установить пакеты из requirements.txt"
    if errorlevel 2 goto :fail
    %PY% -m pip install -r requirements.txt
    %PY% -m ss14map.check deps
    if errorlevel 1 goto :fail
)

rem ---- config
if not exist conf.toml (
    copy /y conf.example.toml conf.toml >nul
    echo [check] Создан conf.toml из conf.example.toml. Укажите в нём path к репозиторию, сохраните и закройте блокнот.
    start /wait notepad conf.toml
)
%PY% -m ss14map.check config
if errorlevel 1 (
    echo [check] Исправьте conf.toml и запустите снова.
    goto :fail
)

%PY% mapper.py %*
pause
exit /b 0

:fail
pause
exit /b 1
