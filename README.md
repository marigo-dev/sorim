# Sorim

Sorim is an AI-driven autonomous Minecraft agent built with Node.js and Mineflayer. The project goal is to make a bot that plays through Minecraft by combining an LLM decision layer with reliable low-level skills for movement, crafting, mining, combat, survival, and base management.

The deterministic skill tree is not the end goal. It exists as the bot's safety layer: it validates AI decisions, provides fallback behavior when the model returns invalid JSON, and keeps early survival skills reliable while the AI layer becomes more capable.

## Architecture

Sorim is designed as an AI-controlled Minecraft body/runtime:

```text
Minecraft world -> perception -> AI brain -> tool call -> safety validation -> skill execution
```

Main parts:

- `bot.js`: connects to Minecraft, observes the world, runs the agent loop, and executes tool calls.
- `llm.js`: talks to Ollama or an OpenAI-compatible API and asks the AI brain for the next tool call.
- `toolRegistry.js`: defines the body tools the AI is allowed to use and maps tool calls to Mineflayer skills.
- `skillTree.js`: provides curriculum context and safe fallback decisions when AI output is invalid or unavailable.
- `skills/`: low-level body abilities such as mining, crafting, movement, food, survival, shelter, and storage.

The AI does not directly control Mineflayer APIs. It chooses from explicit tools such as:

- `mine_block`
- `craft_item`
- `collect_stone`
- `build_shelter`
- `find_food`
- `fight_mob`
- `return_base`
- `organize_storage`

Example AI tool call:

```json
{
  "tool": "mine_block",
  "args": {
    "target": "oak_log"
  },
  "reason": "wood is needed for early tools"
}
```

The safety supervisor can override the AI when survival is urgent, for example when hunger is critical, a hostile mob is too close, or the bot is trapped.

## Current Status

The current AI-agent foundation focuses on early survival:

- collect wood
- craft planks, sticks, crafting table, and wooden pickaxe
- dig a safe staircase for cobblestone
- craft stone pickaxe, stone axe, and stone sword
- build a basic shelter
- run simple survival checks for hunger, mobs, pits, night, and storage
- ask an LLM for decisions when enabled
- fall back to safe deterministic behavior when an AI response is invalid

This is not yet a full human-level Minecraft player. The architecture is intentionally modular so each survival skill and each AI decision layer can be improved independently.

## Requirements

- Node.js 20 or newer
- Java 25 or a Java version supported by your Paper server build
- A Minecraft Java Edition client
- A local PaperMC server or another compatible Java server
- An AI provider: local Ollama or an OpenAI-compatible API

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

## 5. Choose An AI Provider

Sorim is designed to run with an AI model. You have two recommended options:

- Local AI with Ollama
- Remote AI with an OpenAI-compatible API

The deterministic mode exists only for diagnostics and regression testing.

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

Expected behavior:

- bot joins as `marigo`
- searches for wood
- crafts basic tools
- collects cobblestone
- builds a basic shelter
- starts routine survival maintenance

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
| `USE_LLM` | `true` | Keep this enabled for normal AI-agent runs |
| `LLM_PROVIDER` | `ollama` | `ollama`, `openai`, `openai-compatible`; `none` is only for diagnostics |
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

If the bot gets stuck, restart with debug logs:

```powershell
$env:LOG_LEVEL='debug'
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

Try a smaller local model, increase `LLM_TIMEOUT_MS`, or use an OpenAI-compatible API provider.

For diagnostics only, you can temporarily disable AI calls:

```powershell
$env:USE_LLM='false'
npm start
```

This mode is not the main project direction; it is useful for checking whether movement/crafting/mining skills work independently of the model.

### API provider returns invalid JSON

The skill tree validates all AI actions. If the model returns bad JSON, the bot falls back to safe behavior for that loop. Use a low temperature and a model that follows JSON instructions well.

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
