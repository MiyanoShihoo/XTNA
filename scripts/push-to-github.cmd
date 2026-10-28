@echo off
rem Push this repository to GitHub with the TLS backend that works on Windows
rem hosts where schannel reports SEC_E_NO_CREDENTIALS.
rem
rem Double-click, or run from any terminal:
rem   scripts\push-to-github.cmd
setlocal
cd /d "%~dp0.."

echo [push] repository: %CD%
git remote -v | findstr /i "origin"
echo.

git -c http.sslBackend=openssl push -u origin main
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [push] failed with %CODE%.
  echo [push] If it asked for credentials and could not prompt, sign in with
  echo [push] Git Credential Manager once, or run: git push -u origin main
  echo [push] from a normal terminal window.
) else (
  echo.
  echo [push] done. Open https://github.com/MiyanoShihoo/XTNA/actions
)

pause
exit /b %CODE%
