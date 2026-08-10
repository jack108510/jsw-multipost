@echo off
setlocal
set "AMPLR_PS1=%TEMP%\Install-Amplr.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/jack108510/jsw-multipost/main/installers/windows/Install-Amplr.ps1' -OutFile '%AMPLR_PS1%' -UseBasicParsing"
if errorlevel 1 (
  echo Could not download Amplr installer. Check your internet connection.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%AMPLR_PS1%"
