@echo off
rem XTNA environment bootstrap for Windows.
rem
rem Usage:
rem   scripts\xtna-env.cmd                 -> configure this console only
rem   scripts\xtna-env.cmd analyze <path>  -> configure, then run the CLI
rem
rem Every value can be overridden by setting the variable before calling this
rem script. Nothing here downloads or installs anything.

setlocal EnableExtensions
set "XTNA_ROOT=%~dp0.."

rem --- Java for Ghidra 12.2 (JDK 25+) -----------------------------------------
if not defined XTNA_JDK set "XTNA_JDK=E:\AI tools\jdk25\jdk-25.0.5+8"
if exist "%XTNA_JDK%\bin\java.exe" (
  set "JAVA_HOME=%XTNA_JDK%"
  set "PATH=%XTNA_JDK%\bin;%PATH%"
  echo [xtna-env] JDK           %XTNA_JDK%
) else (
  echo [xtna-env] JDK not found at "%XTNA_JDK%" - set XTNA_JDK to a 64-bit JDK 25+
)

rem --- Ghidra ------------------------------------------------------------------
if not defined GHIDRA_INSTALL_DIR set "GHIDRA_INSTALL_DIR=E:\AI tools\ghidra\ghidra_12.2_PUBLIC_20261016\ghidra_12.2_PUBLIC"
if exist "%GHIDRA_INSTALL_DIR%\Ghidra\application.properties" (
  echo [xtna-env] Ghidra        %GHIDRA_INSTALL_DIR%
) else (
  echo [xtna-env] Ghidra missing at "%GHIDRA_INSTALL_DIR%" - set GHIDRA_INSTALL_DIR
)

rem --- apktool ----------------------------------------------------------------
if not defined REA_APKTOOL_COMMAND set "REA_APKTOOL_COMMAND=%XTNA_ROOT%\..\tools\bin\apktool212.bat"
if exist "%REA_APKTOOL_COMMAND%" (
  echo [xtna-env] apktool       %REA_APKTOOL_COMMAND%
) else (
  echo [xtna-env] apktool missing - set REA_APKTOOL_COMMAND
)

rem --- jadx-headless-mcp ------------------------------------------------------
if not defined REA_JADX_MCP_JAR set "REA_JADX_MCP_JAR=%XTNA_ROOT%\..\tools\bin\jadx-headless-mcp-0.7.1-all.jar"
if exist "%REA_JADX_MCP_JAR%" (
  echo [xtna-env] jadx-mcp      %REA_JADX_MCP_JAR%
) else (
  echo [xtna-env] jadx-mcp missing - set REA_JADX_MCP_JAR
)

rem --- aapt2 (optional manifest facts for audit-apk) --------------------------
if not defined REA_AAPT2_COMMAND set "REA_AAPT2_COMMAND=%XTNA_ROOT%\..\tools\_stage\aapt2\aapt2.exe"
if exist "%REA_AAPT2_COMMAND%" (
  echo [xtna-env] aapt2         %REA_AAPT2_COMMAND%
) else (
  echo [xtna-env] aapt2 not present - audit-apk will report the manifest as unavailable
)

echo.

if "%~1"=="" (
  echo [xtna-env] Environment ready in this console. Run: node scripts\rea.mjs --help
  endlocal & exit /b 0
)

node "%XTNA_ROOT%\scripts\rea.mjs" %*
set "XTNA_EXIT=%ERRORLEVEL%"
endlocal & exit /b %XTNA_EXIT%
