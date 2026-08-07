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
- `colony.js`: runs two cooperating agents with shared tasks and storage.
- `llm.js`: talks to Ollama or an OpenAI-compatible API and asks the AI brain for the next tool call.
- `protocol26Shim.js`: native Minecraft 26.2 protocol compatibility layer.
- `toolRegistry.js`: defines the body tools the AI is allowed to use and maps tool calls to Mineflayer skills.
- `skillTree.js`: provides curriculum context and safe fallback decisions when AI output is invalid or unavailable.
- `skills/`: low-level body abilities such as mining, crafting, movement, food, survival, shelter, and storage.

The AI does not directly control Mineflayer APIs. It chooses from explicit tools such as:

- `mine_block`
- `craft_item`
- `collect_stone`
- `build_shelter`
- `find_food`
- `maintain_food_supply`
- `fight_mob`
- `evade_hostile`
- `emergency_shelter`
- `return_base`
- `organize_storage`
- `prepare_mining_kit`
- `mine_iron`
- `smelt_item`
- `craft_iron_kit`
- `craft_iron_armor`
- `secure_bed`
- `establish_wheat_farm`
- `build_blueprint`
- `ensure_shared_storage`

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

The current AI-agent foundation includes:

- collect wood
- scan for trees while exploring, interrupt the route when one appears, and cross uneven terrain using safe local steps
- craft planks, sticks, crafting table, and wooden pickaxe
- dig a safe staircase for cobblestone
- craft stone pickaxe, stone axe, and stone sword
- build a basic shelter
- run simple survival checks for hunger, mobs, pits, night, and storage
- evade unsafe fights when unarmed, while continuing to fight with an appropriate weapon
- seal a temporary three-block-deep refuge when the first night arrives before a base exists, then climb out in daylight
- obtain and place a bed, return to it at night, and sleep on the surface
- create a hydrated wheat farm, expand it as seeds become available, harvest mature crops in batches, and replant seeds
- maintain a reserve of at least 16 edible items and wait safely at the base while crops grow
- prepare a mining kit, mine and smelt iron, craft the core iron kit, and equip full iron armor while preserving an 8-ingot reserve
- execute creative-mode blueprints and showcase builds
- run two-agent colony experiments with shared storage
- ask an LLM for decisions when enabled
- fall back to safe deterministic behavior when an AI response is invalid

The native 26.2 survival chain has been exercised in live runs through shelter, food fallback, persistent base and farm memory, chest storage, bed placement and sleep, a hydrated wheat farm, the complete iron-age crafting chain, and full iron armor. Controlled server-side tests verified expansion to 48 farmland blocks, batched crop harvest and replanting, a 20-bread reserve, the equipped armor, an 8-ingot reserve, hostile detection, iron-sword combat, and survival on Easy difficulty. A fresh natural-terrain run also verified route-time tree detection, safe traversal from a high plains spawn to a forest, and complete chopping of a six-log oak. A separate night test verified emergency refuge construction, protected waiting, and physical pillar-up recovery after sunrise. Long unsupervised runs in naturally generated terrain are still experimental. This is not yet a full human-level Minecraft player.

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

Mineflayer may not always support the newest Minecraft protocol immediately. Sorim includes a local compatibility shim for native Paper 26.2 connections without ViaVersion or ViaBackwards:

```powershell
$env:MC_VERSION='26.2'
npm start
```

The shim currently covers the 26.2 registry, inventory component, incremental world-clock, entity, particle, and attack packet differences exercised by the survival skills. Future Paper or Minecraft protocol changes may require new mappings.

### Optional 1.21 bridge mode

For servers where native 26.2 is not required, the older bridge setup remains available. Install these plugins in `mc-server/plugins/`:

- ViaVersion
- ViaBackwards

Then restart the server. This lets the bot connect with an older supported protocol while the server runs a newer build.

Set `MC_VERSION=1.21` when using the bridge. Native 26.2 does not require either plugin.

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
ollama pull hermes3:8b
```

### One-click Windows launch

After installing Java, Node.js, and Ollama and pulling the model, double-click
`start-sorim.bat` or run:

```powershell
.\start-sorim.bat
```

The launcher checks the Paper server, starts it when necessary, checks Ollama,
warms the selected model, and then starts Marigo. In this development workspace
it automatically uses `mc-server-26-2-test` on `127.0.0.1:25566`. In a clean
clone it uses the published `mc-server` directory on `127.0.0.1:25565`.

The launcher enables AI tool selection but does not begin autonomous progression
without permission. Join the server and send `marigo otonom basla` in chat.

Start the bot:

PowerShell:

```powershell
$env:LLM_PROVIDER='ollama'
$env:OLLAMA_MODEL='hermes3:8b'
npm start
```

Bash:

```bash
LLM_PROVIDER=ollama OLLAMA_MODEL=hermes3:8b npm start
```

Expected behavior:

- bot joins as `marigo`
- bot waits for an in-game start command
- searches for wood
- crafts basic tools
- collects cobblestone
- builds a basic shelter
- starts routine survival maintenance

Start autonomous planning in chat:

```text
marigo otonom basla
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
| `MC_VERSION` | `26.2` | Mineflayer protocol version; use `1.21` only with the optional bridge |
| `MC_USERNAME` | `marigo` | Bot username |
| `LOOP_DELAY_MS` | `1500` | Main loop delay |
| `LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, or `debug` |
| `AUTONOMOUS_ON_START` | `false` | Start planning immediately instead of waiting for chat |
| `ENABLE_EXPERIMENTAL_26_2` | `false` | Enable the native 26.2 protocol shim |

LLM:

| Variable | Default | Description |
| --- | --- | --- |
| `USE_LLM` | `true` | Keep this enabled for normal AI-agent runs |
| `LLM_PROVIDER` | `ollama` | `ollama`, `openai`, `openai-compatible`; `none` is only for diagnostics |
| `LLM_TIMEOUT_MS` | `30000` | AI planning request timeout |
| `CHAT_TIMEOUT_MS` | `45000` | AI chat request timeout; allows a cold local model to load |
| `LLM_MODEL` | empty | Shared model override |
| `OLLAMA_URL` | `http://127.0.0.1:11434/api/generate` | Ollama native generate endpoint |
| `OLLAMA_MODEL` | `hermes3:8b` | Ollama model |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `OPENAI_API_KEY` | empty | API key for OpenAI-compatible provider |
| `OPENAI_MODEL` | `gpt-4.1-mini` | OpenAI-compatible model |
| `USE_LLM_PLANNER` | `false` | Let the LLM select high-level tools; `start-sorim.bat` enables it |

Copy `.env.example` values into your shell or preferred environment loader as a starting point. Node.js does not automatically load this file.

## 9. Colony Mode

Run the two-agent experiment:

```powershell
$env:COLONY_ALPHA='marigo_alpha'
$env:COLONY_BETA='marigo_beta'
$env:COLONY_CENTER='1800,70,0'
npm run colony
```

The colony runtime coordinates roles, shared tasks, a common build center, and shared storage. It is an MVP experiment rather than the default solo progression mode.

## 10. Logs

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

## 11. In-Game Chat

The bot responds when its name is mentioned.

Examples:

```text
marigo status
marigo durum
marigo otonom basla
marigo otonom dur
marigo beni takip et
marigo agac kes
```

Status returns:

- current level
- coordinates
- health
- hunger
- inventory summary

## 12. Test Checklist

After starting the server and bot, watch for this sequence:

1. Bot joins the server.
2. Bot scans while exploring, safely crosses uneven terrain, finds trees, and collects the complete trunk.
3. Bot crafts planks, sticks, crafting table, and wooden pickaxe.
4. Bot digs a safe staircase for stone.
5. Bot crafts stone pickaxe, stone axe, and stone sword.
6. Bot builds a small shelter and stores a base coordinate.
7. Bot works toward a reserve of 16 edible items, cooks raw food when a furnace and fuel are available, and uses its farm before searching farther away.
8. Bot places a chest and deposits excess inventory while keeping survival tools and food.
9. If night arrives and no bed exists, bot reduces risky outdoor tasks.
10. If the first night arrives before a base exists, the bot seals an emergency refuge and climbs back to the remembered surface after sunrise.
11. Bot obtains three matching wool, crafts and places a bed, then sleeps there when night arrives on the surface.
12. Bot preserves the iron reserve while making a bucket, collects water, creates the first eight hydrated farmland blocks, and plants wheat.
13. The farm expands toward 48 farmland blocks as seeds become available. Mature wheat is harvested in bounded batches and immediately replanted; while crops grow, the bot waits safely at its base instead of roaming for food.
14. Bot prepares torches and fuel, mines and smelts enough iron for its core kit and an 8-ingot reserve.
15. Bot collects the additional armor iron, crafts and equips full iron armor, and keeps the reserve intact.
16. On Easy difficulty, an unarmed bot evades an unsafe fight; once armed, a nearby hostile is fought with the best available weapon.

If the bot gets stuck, restart with debug logs:

```powershell
$env:LOG_LEVEL='debug'
npm start
```

## 13. Troubleshooting

### Bot cannot connect

- Check that the server is running.
- Check `MC_HOST`, `MC_PORT`, and `MC_VERSION`.
- For native Paper 26.2, keep `MC_VERSION=26.2`; for other unsupported server versions, use the optional ViaVersion/ViaBackwards bridge with `MC_VERSION=1.21`.

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

## 14. Repository Notes

The repository intentionally excludes:

- `node_modules/`
- runtime logs
- local memory files under `data/` and `memory/`
- Minecraft world files
- downloaded server jars
- local 26.2 test server files

Older experimental code can remain under:

```text
legacy-old-agent/
```
