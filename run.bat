@echo off
setlocal enabledelayedexpansion
echo.
echo =====================================
echo ITRM Tracker App - Startup Script
echo =====================================
echo.
REM ============================================================================
REM 1. Check for local Node.js in node-v24 folder
REM ============================================================================
echo [1/4] Checking Node.js installation...
set "NODE_DIR=%~dp0node-v24.19.0-win-x64"
set "NODE_EXE=%NODE_DIR%\node.exe"
if exist "%NODE_EXE%" (
   echo OK: Found local Node.js at %NODE_EXE%
   for /f "tokens=*" %%i in ('"%NODE_EXE%" -v') do set NODE_VERSION=%%i
   echo     Version: !NODE_VERSION!
   set "PATH=%NODE_DIR%;%PATH%"
) else (
   echo Local Node.js not found at %NODE_EXE%, falling back to node on PATH
   set "NODE_EXE=node"
)
echo.
REM ============================================================================
REM 2. Check SQL Server configuration
REM ============================================================================
echo [2/4] Checking SQL Server configuration...
if not exist "%~dp0.env" (
   echo ERROR: .env not found. Copy .env.example to .env and set
   echo        SQL_SERVER, SQL_PORT, SQL_DATABASE, SQL_USER and SQL_PASSWORD.
   pause
   exit /b 1
)
echo OK: Using settings from .env
echo.
REM ============================================================================
REM 3. Install dependencies and seed the lookup tables
REM ============================================================================
echo [3/4] Preparing application...
if not exist "%~dp0node_modules\mssql" (
   echo   Installing dependencies ^(npm install^)...
   pushd "%~dp0"
   call npm install --omit=dev
   popd
)
"%NODE_EXE%" "%~dp0db\seed.js"
if errorlevel 1 (
   echo ERROR: Could not initialize the SQL Server database. Check .env and that the server is reachable.
   pause
   exit /b 1
)
echo.
REM ============================================================================
REM 4. Start the server
REM ============================================================================
echo [4/4] Starting ITRM Tracker App...
echo.
if "%PORT%"=="" set PORT=3000
echo ======================================
echo OK: App is starting...
echo.
echo   URL: http://localhost:%PORT%
echo.
echo   Close this window to stop
echo ======================================
echo.

start http://localhost:%PORT%
"%NODE_EXE%" "%~dp0server.js"
