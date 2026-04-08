@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org/ and ensure "node" is on your PATH.
  echo.
  set /p "_zt_done=Press Enter to close... "
  exit /b 1
)

:menu
echo.
echo ZT PNG Converter
echo   1  PNG to ZT1
echo   2  ZT1 to PNG
echo   Q  Quit
echo.
set "c="
set /p "c=Enter choice (1, 2, or Q): "
if /i "%c%"=="1" goto run_png_to_zt1
if /i "%c%"=="2" goto run_zt1_to_png
if /i "%c%"=="q" exit /b 0
goto menu

:run_png_to_zt1
set "ZT_CONVERTER_FROM_LAUNCHER=1"
node "%~dp0src\pngToZt1Assets.js"
goto done

:run_zt1_to_png
set "ZT_CONVERTER_FROM_LAUNCHER=1"
node "%~dp0src\zt1GraphicToPng.js"
goto done

:done
echo.
set /p "_zt_done=Press Enter to close... "
exit /b 0
