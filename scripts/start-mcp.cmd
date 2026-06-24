@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "PLUGIN_DIR=%%~fI"

if defined NODE_EXE if exist "%NODE_EXE%" (
  set "CODEX_SSH_NODE=%NODE_EXE%"
  goto run
)

if defined NODE_PATH if exist "%NODE_PATH%" (
  set "CODEX_SSH_NODE=%NODE_PATH%"
  goto run
)

if defined NODE_REPL_NODE_PATH if exist "%NODE_REPL_NODE_PATH%" (
  set "CODEX_SSH_NODE=%NODE_REPL_NODE_PATH%"
  goto run
)

if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  set "CODEX_SSH_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  goto run
)

for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do (
  if exist "%%~fD\bin\node.exe" set "CODEX_SSH_NODE=%%~fD\bin\node.exe"
)
if defined CODEX_SSH_NODE goto run

where node.exe >nul 2>nul
if not errorlevel 1 (
  set "CODEX_SSH_NODE=node.exe"
  goto run
)

echo Codex SSH MCP launcher could not find node.exe. 1>&2
exit /b 1

:run
cd /d "%PLUGIN_DIR%" || exit /b 1
"%CODEX_SSH_NODE%" ".\mcp\server.mjs"
