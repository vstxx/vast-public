@echo off
setlocal
cd /d "%~dp0"
echo Preparing the private local Vast test update from this checkout...
call npm run alpha:prepare
if errorlevel 1 goto failed
echo.
echo The verified test package is ready. Close all Vast windows now.
pause
call npm run alpha:apply
if errorlevel 1 goto failed
echo.
echo Local test update completed. Start Vast from your usual shortcut.
pause
exit /b 0
:failed
echo.
echo The local update did not complete. Read the error above; your browser was not force-closed.
pause
exit /b 1
