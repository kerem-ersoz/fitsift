@echo off
setlocal EnableDelayedExpansion

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\fitsift-windows.ps1" %*
if errorlevel 1 (
  set "FITSIFT_EXIT_CODE=%ERRORLEVEL%"
  echo.
  echo FitSift could not be started. Review the error above.
  pause
  exit /b !FITSIFT_EXIT_CODE!
)
