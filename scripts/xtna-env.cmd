@echo off
rem XTNA environment bootstrap for Windows.
rem
rem Usage:
rem   scripts\xtna-env.cmd                 -> configure this console only
rem   scripts\xtna-env.cmd analyze <path>  -> configure, then run the CLI
rem
rem Nothing here downloads or installs anything. Every value can be overridden
rem by setting the variable before calling this script; see the table in
rem README.md ("Windows environment").

setlocal EnableExtensions
set "XTNA_ROOT=%~dp0.."
if not defined XTNA_TOOLS_DIR set "XTNA_TOOLS_DIR=%XTNA_ROOT%\..\tools"

rem --- Java ---------------------------------------------------------------------
rem Ghidra 12.2 needs a 64-bit JDK 25+. Point XTNA_JDK at one, or pre-set JAVA_HOME.
if not defined JAVA_HOME if defined XTNA_JDK set "JAVA_HOME=%XTNA_JDK%"
if defined JAVA_HOME (
  if exist "%JAVA_HOME%\bin\java.exe" (
    set "PATH=%JAVA_HOME%\bin;%PATH%"
    echo [xtna-env] JDK           %JAVA_HOME%
  ) else (
    echo [xtna-env] JAVA_HOME is set but has no bin\java.exe: "%JAVA_HOME%"
  )
) else (
  echo [xtna-env] JAVA_HOME not set - set XTNA_JDK or JAVA_HOME to a 64-bit JDK 25+
)

rem --- Ghidra -------------------------------------------------------------------
if defined GHIDRA_INSTALL_DIR (
  if exist "%GHIDRA_INSTALL_DIR%\Ghidra\application.properties" (
    echo [xtna-env] Ghidra        %GHIDRA_INSTALL_DIR%
  ) else (
    echo [xtna-env] GHIDRA_INSTALL_DIR has no Ghidra\application.properties: "%GHIDRA_INSTALL_DIR%"
  )
) else (
  echo [xtna-env] Ghidra not configured - set GHIDRA_INSTALL_DIR to an extracted 12.x release
)

rem --- apktool ------------------------------------------------------------------
if not defined REA_APKTOOL_COMMAND set "REA_APKTOOL_COMMAND=%XTNA_TOOLS_DIR%\bin\apktool.bat"
if exist "%REA_APKTOOL_COMMAND%" (
  echo [xtna-env] apktool       %REA_APKTOOL_COMMAND%
) else (
  echo [xtna-env] apktool not found - set REA_APKTOOL_COMMAND to a launcher
)

rem --- jadx-headless-mcp --------------------------------------------------------
if not defined REA_JADX_MCP_JAR set "REA_JADX_MCP_JAR=%XTNA_TOOLS_DIR%\bin\jadx-headless-mcp-0.7.1-all.jar"
if exist "%REA_JADX_MCP_JAR%" (
  echo [xtna-env] jadx-mcp      %REA_JADX_MCP_JAR%
) else (
  echo [xtna-env] jadx-mcp not found - set REA_JADX_MCP_JAR to the released jar
)

rem --- aapt2 (optional manifest facts for audit-apk) -----------------------------
if not defined REA_AAPT2_COMMAND set "REA_AAPT2_COMMAND=%XTNA_TOOLS_DIR%\_stage\aapt2\aapt2.exe"
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
