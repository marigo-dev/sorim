@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

title Sorim AI Bot Launcher

if not defined SORIM_SERVER_DIR (
    if exist "%CD%\mc-server-26-2-test\server.jar" (
        set "SORIM_SERVER_DIR=%CD%\mc-server-26-2-test"
        if not defined MC_PORT set "MC_PORT=25566"
    ) else (
        set "SORIM_SERVER_DIR=%CD%\mc-server"
        if not defined MC_PORT set "MC_PORT=25565"
    )
)

if not defined MC_HOST set "MC_HOST=127.0.0.1"
if not defined MC_USERNAME set "MC_USERNAME=marigo"
if not defined MC_VERSION set "MC_VERSION=26.2"
if not defined LLM_PROVIDER set "LLM_PROVIDER=deepseek"
if not defined DEEPSEEK_BASE_URL set "DEEPSEEK_BASE_URL=https://api.deepseek.com"
if not defined DEEPSEEK_MODEL set "DEEPSEEK_MODEL=deepseek-v4-flash"
if not defined OLLAMA_MODEL set "OLLAMA_MODEL=qwen3.5:9b"
if not defined OLLAMA_URL set "OLLAMA_URL=http://127.0.0.1:11434/api/chat"
if not defined OLLAMA_CONTEXT_SIZE set "OLLAMA_CONTEXT_SIZE=4096"
if not defined LLM_TIMEOUT_MS set "LLM_TIMEOUT_MS=30000"
if not defined CHAT_TIMEOUT_MS set "CHAT_TIMEOUT_MS=45000"
if not defined USE_LLM_PLANNER set "USE_LLM_PLANNER=true"
if not defined AUTONOMOUS_ON_START set "AUTONOMOUS_ON_START=false"

echo [SORIM] Server: !SORIM_SERVER_DIR!
echo [SORIM] Minecraft: !MC_HOST!:!MC_PORT! version !MC_VERSION!
echo [SORIM] Bot: !MC_USERNAME!
if /I "!LLM_PROVIDER!"=="deepseek" (
    echo [SORIM] AI: !LLM_PROVIDER! / !DEEPSEEK_MODEL! planner=!USE_LLM_PLANNER!
) else (
    echo [SORIM] AI: !LLM_PROVIDER! / !OLLAMA_MODEL! planner=!USE_LLM_PLANNER!
)

if /I "%SORIM_DRY_RUN%"=="true" (
    echo [SORIM] Dry run complete.
    exit /b 0
)

if not exist "!SORIM_SERVER_DIR!\server.jar" (
    echo [ERROR] server.jar was not found in !SORIM_SERVER_DIR!.
    echo Put the Paper 26.2 server jar there as server.jar.
    pause
    exit /b 1
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort $env:MC_PORT -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo [SORIM] Starting Paper server...
    start "Sorim Paper 26.2" /D "!SORIM_SERVER_DIR!" cmd /k baslat.cmd
) else (
    echo [SORIM] Paper is already listening on port !MC_PORT!.
)

echo [SORIM] Waiting for Minecraft port...
powershell -NoProfile -Command "$end=(Get-Date).AddSeconds(90); while ((Get-Date) -lt $end) { if (Get-NetTCPConnection -State Listen -LocalPort $env:MC_PORT -ErrorAction SilentlyContinue) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
    echo [ERROR] Paper did not open port !MC_PORT! within 90 seconds.
    pause
    exit /b 1
)

if /I "!LLM_PROVIDER!"=="ollama" (
    powershell -NoProfile -Command "try { $null=Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
    if errorlevel 1 (
        echo [SORIM] Starting Ollama...
        start "Sorim Ollama" /min ollama serve
        powershell -NoProfile -Command "$end=(Get-Date).AddSeconds(30); while ((Get-Date) -lt $end) { try { $null=Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2; exit 0 } catch { Start-Sleep -Milliseconds 500 } }; exit 1"
        if errorlevel 1 (
            echo [ERROR] Ollama did not become ready.
            pause
            exit /b 1
        )
    )

    powershell -NoProfile -Command "$tags=Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags'; if ($tags.models.name -notcontains $env:OLLAMA_MODEL) { exit 1 }"
    if errorlevel 1 (
        echo [ERROR] Ollama model !OLLAMA_MODEL! is not installed.
        echo Run: ollama pull !OLLAMA_MODEL!
        pause
        exit /b 1
    )

    echo [SORIM] Warming !OLLAMA_MODEL!; the first launch can take about 30 seconds...
    powershell -NoProfile -Command "$body=ConvertTo-Json @{model=$env:OLLAMA_MODEL;messages=@(@{role='user';content='Return ready.'});stream=$false;keep_alive='30m';options=@{num_predict=1;num_ctx=[int]$env:OLLAMA_CONTEXT_SIZE}} -Depth 6; try { $null=Invoke-RestMethod -Uri $env:OLLAMA_URL -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 90; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
    if errorlevel 1 echo [WARN] Ollama warm-up failed; chat will retry from the bot.
)

echo [SORIM] Starting AI bot. Autonomous planning waits for an in-game command.
echo [SORIM] Say: marigo otonom basla
echo [SORIM] Stop the bot with Ctrl+C. The Paper window stays open.
node src\bot.js

echo [SORIM] Bot stopped with exit code !ERRORLEVEL!.
pause
