@echo off
REM Double-click this file in Explorer to start axona.portal on Windows.
REM Close the window (or press Ctrl+C) to stop it.
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   x Node.js was not found.
  echo.
  echo     axona.portal needs Node 20 or newer.
  echo     Install it from https://nodejs.org and try again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set MAJOR=%%v
if %MAJOR% LSS 20 (
  echo.
  echo   x Node is too old — axona.portal needs Node 20 or newer.
  node -v
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\@axona" (
  echo   first run — installing dependencies, this takes a minute...
  call npm install || (echo npm install failed. & pause & exit /b 1)
)

echo.
node src\index.js
pause
