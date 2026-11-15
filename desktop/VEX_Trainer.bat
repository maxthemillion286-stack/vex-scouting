@echo off
setlocal
title VEX Trainer
rem VEX Trainer - the desktop half of the robot tracker on vex-scouting.
rem Put this file anywhere and double-click it. It makes a folder called
rem VEX_Trainer next to itself, installs what it needs there (nothing is
rem installed system-wide), fetches the newest version of the program from
rem the website, and starts it.
cd /d "%~dp0"
if not exist VEX_Trainer mkdir VEX_Trainer
cd VEX_Trainer

set PY=
for %%V in (3.12 3.11 3.13 3.10) do (
  if not defined PY ( py -%%V -c "print(1)" >nul 2>nul && set PY=py -%%V )
)
if not defined PY ( python -c "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)" >nul 2>nul && set PY=python )
if not defined PY (
  echo Python 3.10 to 3.13 is needed and was not found.
  echo Get Python 3.12 from https://www.python.org/downloads/ and tick "Add python.exe to PATH" when installing.
  echo Then double-click this file again.
  pause
  exit /b 1
)

if not exist venv\Scripts\python.exe (
  echo Setting up, the first time only...
  %PY% -m venv venv
  if errorlevel 1 ( echo Could not set up. & pause & exit /b 1 )
)
set VPY=venv\Scripts\python.exe
if not exist venv\ready2.txt (
  echo Installing what it needs, a few minutes the first time...
  %VPY% -m pip install -q --upgrade pip
  %VPY% -m pip install -q numpy opencv-python onnxruntime-directml yt-dlp
  if errorlevel 1 ( echo Something did not install. Check the internet connection and try again. & pause & exit /b 1 )
  echo ok> venv\ready2.txt
) else (
  rem The downloader has to keep up with YouTube.
  %VPY% -m pip install -q --upgrade yt-dlp >nul 2>nul
)

echo Getting the newest version of the program...
curl -fsSL -o vex_trainer.new "https://vex-scouting-by-max.vercel.app/desktop/vex_trainer.py"
if errorlevel 1 (
  if not exist vex_trainer.py ( echo Could not reach the website. & pause & exit /b 1 )
  echo Could not reach the website; using the copy already here.
) else (
  move /y vex_trainer.new vex_trainer.py >nul
)

%VPY% vex_trainer.py
echo.
pause
