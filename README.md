# Sorim

Sorim is an autonomous Minecraft agent built with Node.js, Mineflayer, and a deterministic skill-tree/state-machine loop. The bot can run fully deterministic without an LLM, use a local Ollama model, or connect to an OpenAI-compatible API.

## Current Status

The current bot focuses on early survival:

- collect wood
- craft planks, sticks, crafting table, and wooden pickaxe
- dig a safe staircase for cobblestone
- craft stone pickaxe, stone axe, and stone sword
- build a basic shelter
- run simple survival checks for hunger, mobs, pits, night, and storage

This is not yet a full human-level Minecraft player. The architecture is intentionally modular so each survival skill can be improved independently.

## Requirements

- Node.js 20 or newer
- Java 25 or a Java version supported by your Paper server build
- A Minecraft Java Edition client
- A local PaperMC server or another compatible Java server
- Optional: Ollama or an OpenAI-compatible API key

Official references:

- Paper downloads: <https://papermc.io/downloads/paper>
- Paper Java install guide: <https://docs.papermc.io/misc/java-install/>
- ViaVersion: <https://hangar.papermc.io/ViaVersion/ViaVersion>
- ViaBackwards: <https://hangar.papermc.io/ViaVersion/ViaBackwards>
- Ollama: <https://ollama.com/download>
- OpenAI Chat Completions API reference: <https://developers.openai.com/api/reference/resources/chat>

## 1. Clone And Install

```bash
git clone https://github.com/marigo-dev/sorim.git
cd sorim
npm install
```

Run a syntax check:

```bash
npm test
```

## 2. Create A Local Paper Server

Create a server folder:

```powershell
mkdir mc-server
cd mc-server
```

Download the latest stable Paper jar from:

```text
https://papermc.io/downloads/paper
```

Rename the downloaded file to:

```text
server.jar
```

Start the server once:

```powershell
java -jar server.jar --nogui
```

The first run will stop and ask you to accept the Minecraft EULA. Open `eula.txt` and change:

```text
eula=false
```

to:

```text
eula=true
```

Start the server again:

```powershell
java -jar server.jar --nogui
```

## 3. Recommended Server Settings For Testing

Open `mc-server/server.properties` and use simple local settings while testing:

```properties
online-mode=false
difficulty=easy
spawn-protection=0
view-distance=10
simulation-distance=10
```

Why:

- `online-mode=false` makes local offline bot names easier to test.
- `spawn-protection=0` prevents the bot from finding a tree near spawn and being unable to break it.
- `difficulty=easy` lets survival systems be tested without being too punishing.

Restart the server after changing `server.properties`.

## 4. Version Compatibility

Mineflayer may not always support the newest Minecraft protocol immediately. The bot defaults to:

```text
MC_VERSION=1.21
```

If your Paper server is newer, install these plugins in `mc-server/plugins/`:

- ViaVersion
- ViaBackwards

Then restart the server. This lets the bot connect with an older supported protocol while the server runs a newer build.

## 5. Run The Bot Without Any LLM

This is the best first test. The deterministic skill tree will make all early-game decisions.

PowerShell:

```powershell
$env:USE_LLM='false'
npm start
```

Bash:

```bash
USE_LLM=false npm start
```

Expected behavior:

- bot joins as `marigo`
- searches for wood
- crafts basic tools
- collects cobblestone
- builds a basic shelter
- starts routine survival maintenance

## 6. Run With Local Ollama

Install Ollama:

```text
https://ollama.com/download
```

Pull a model:

```bash
ollama pull qwen3:4b
```

Start the bot:

PowerShell:

```powershell
$env:LLM_PROVIDER='ollama'
$env:OLLAMA_MODEL='qwen3:4b'
npm start
```

Bash:

```bash
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen3:4b npm start
```

Default Ollama endpoint:

```text
http://127.0.0.1:11434/api/generate
```

Override it if needed:

```powershell
$env:OLLAMA_URL='http://127.0.0.1:11434/api/generate'
```

## 7. Run With An OpenAI-Compatible API

Sorim supports a generic OpenAI-compatible chat completions endpoint. This can be OpenAI or another provider that implements the same `/chat/completions` shape.

PowerShell:

```powershell
$env:LLM_PROVIDER='openai-compatible'
$env:OPENAI_API_KEY='your-api-key'
$env:OPENAI_MODEL='your-model-name'
npm start
```

Bash:

```bash
LLM_PROVIDER=openai-compatible OPENAI_API_KEY='your-api-key' OPENAI_MODEL='your-model-name' npm start
```

Defaults:

```text
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
```

For another compatible provider:

```powershell
$env:OPENAI_BASE_URL='https://your-provider.example/v1'
$env:OPENAI_API_KEY='your-api-key'
$env:OPENAI_MODEL='your-model-name'
$env:LLM_PROVIDER='openai-compatible'
npm start
```

## 8. Environment Variables

Core:

| Variable | Default | Description |
| --- | --- | --- |
| `MC_HOST` | `localhost` | Minecraft server host |
| `MC_PORT` | `25565` | Minecraft server port |
| `MC_VERSION` | `1.21` | Mineflayer protocol version |
| `MC_USERNAME` | `marigo` | Bot username |
| `LOOP_DELAY_MS` | `1500` | Main loop delay |
| `LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, or `debug` |

LLM:

| Variable | Default | Description |
| --- | --- | --- |
| `USE_LLM` | `true` | Set to `false` to disable LLM calls |
| `LLM_PROVIDER` | `ollama` | `none`, `ollama`, `openai`, or `openai-compatible` |
| `LLM_TIMEOUT_MS` | `12000` | LLM request timeout |
| `LLM_MODEL` | empty | Shared model override |
| `OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Ollama native generate endpoint |
| `OLLAMA_MODEL` | `qwen3:4b` | Ollama model |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `OPENAI_API_KEY` | empty | API key for OpenAI-compatible provider |
| `OPENAI_MODEL` | `gpt-4.1-mini` | OpenAI-compatible model |

## 9. Logs

Default:

```bash
npm start
```

Detailed debugging:

PowerShell:

```powershell
$env:LOG_LEVEL='debug'
npm start
```

Bash:

```bash
LOG_LEVEL=debug npm start
```

Debug mode prints movement, crafting, mining, storage, and survival loop details.

## 10. In-Game Chat

The bot responds when its name is mentioned.

Examples:

```text
marigo status
marigo durum
```

Status returns:

- current level
- coordinates
- health
- hunger
- inventory summary

## 11. Test Checklist

After starting the server and bot, watch for this sequence:

1. Bot joins the server.
2. Bot finds trees and collects logs.
3. Bot crafts planks, sticks, crafting table, and wooden pickaxe.
4. Bot digs a safe staircase for stone.
5. Bot crafts stone pickaxe, stone axe, and stone sword.
6. Bot builds a small shelter and stores a base coordinate.
7. Bot checks food and storage routines.
8. If night arrives and no bed exists, bot reduces risky outdoor tasks.

If the bot gets stuck, restart with:

```powershell
$env:LOG_LEVEL='debug'
$env:USE_LLM='false'
npm start
```

## 12. Troubleshooting

### Bot cannot connect

- Check that the server is running.
- Check `MC_HOST`, `MC_PORT`, and `MC_VERSION`.
- If the server is newer than Mineflayer supports, install ViaVersion and ViaBackwards.

### Bot joins but cannot break blocks

Set this in `server.properties`:

```properties
spawn-protection=0
```

Then restart the server.

### Bot is too noisy

Use the default `LOG_LEVEL=info`. Only use `debug` while diagnosing behavior.

### Ollama is slow

Use deterministic mode:

```powershell
$env:USE_LLM='false'
npm start
```

Or try a smaller local model.

### API provider returns invalid JSON

The skill tree validates all LLM actions. If the model returns bad JSON, the bot falls back to deterministic behavior. Use a low temperature and a model that follows JSON instructions well.

## 13. Repository Notes

The repository intentionally excludes:

- `node_modules/`
- runtime logs
- local memory files under `data/`
- Minecraft world files
- downloaded server jars

Older experimental code can remain under:

```text
legacy-old-agent/
```
