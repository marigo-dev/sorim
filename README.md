# MarigoBot

An autonomous Minecraft bot built with Mineflayer and a deterministic skill-tree/state-machine loop.

## Installation

```bash
npm install
```

## Run

```bash
npm start
```

Default settings:

- `MC_HOST=localhost`
- `MC_PORT=25565`
- `MC_VERSION=1.21`
- `MC_USERNAME=marigo`
- `USE_LLM=true`
- `OLLAMA_MODEL=qwen3:4b`

To test with the deterministic skill tree and no LLM:

```bash
USE_LLM=false npm start
```

Windows PowerShell:

```powershell
$env:USE_LLM='false'; npm start
```

## Log Level

The default log level is `info`. At this level, only important events and warnings are printed.

For detailed mining, crafting, movement, and state logs:

```bash
LOG_LEVEL=debug npm start
```

PowerShell:

```powershell
$env:LOG_LEVEL='debug'; npm start
```

## Test

```bash
npm test
```

## Notes

- `mc-server/`, `data/`, `node_modules/`, and test logs are excluded from GitHub.
- Older experimental agent code can remain under `legacy-old-agent/`.
