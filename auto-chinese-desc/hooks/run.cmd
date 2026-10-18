@echo off
rem Prefer the agent-reach venv, then Python 3.8, then PATH python.
set "PYEXE=%USERPROFILE%\.agent-reach-venv\Scripts\python.exe"
if not exist "%PYEXE%" set "PYEXE=%LOCALAPPDATA%\Programs\Python\Python38\python.exe"
if not exist "%PYEXE%" set "PYEXE=python"
"%PYEXE%" "%~dp0gen_chinese_desc.py"
if errorlevel 1 (
    echo [auto-chinese-desc] FAILED: no usable Python found. Install Python or edit PYEXE in this file. 1>&2
    exit /b 1
)
