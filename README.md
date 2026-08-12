# Sorim

Sorim is an AI-driven autonomous Minecraft agent built with Node.js and Mineflayer. The project goal is to make a bot that plays through Minecraft by combining an LLM decision layer with reliable low-level skills for movement, crafting, mining, combat, survival, and base management.

The deterministic skill tree is not the end goal. It exists as the bot's safety layer: it validates AI decisions, provides fallback behavior when the model returns invalid JSON, and keeps early survival skills reliable while the AI layer becomes more capable.

## Architecture

Sorim is designed as an AI-controlled Minecraft body/runtime:

```text
Minecraft -> sensors -> normalized world state -> blackboard -> behavior tree
          -> safety / player task / profession / AI planning -> validated skill
```

Main parts:

- `bot.js`: connects to Minecraft, observes the world, runs the agent loop, and executes tool calls.
- `colony.js`: runs two cooperating agents with shared tasks and storage.
- `docs/COLONY_ROADMAP.md`: defines the planned single-brain, multi-agent colony, identity, personality, election, succession, and memorial systems.
- `llm.js`: talks to Ollama or an OpenAI-compatible API and asks the AI brain for the next tool call.
- `perception/`: maintains a normalized world state and bounded event stream from health, inventory, blocks, entities, chat, damage, and sound packets.
- `agent/`: contains the blackboard, persistent social/task memory, task queue, and behavior tree runtime.
- `professions/`: defines persistent farmer, rancher, miner, lumberjack, fisher, builder, guard, and quartermaster profiles.
- `safety/`: protects remembered builds from harvesting and scores terrain before construction.
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
- `care_for_animals`
- `fish`
- `replant_sapling`
- `fight_mob`
- `fight_player` (explicit duel or lethal command only)
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
- remember player conversations, important episodes, active tasks, professions, and protected build zones across restarts
- verify task outcomes from world state and inventory deltas instead of treating a resolved skill promise as success
- insert dynamic base, material, terrain, and mining-kit preconditions before queued work
- persist player commitments, rolling conversation summaries, and proactive task completion/failure reports
- lease exclusive colony work with expiry and disconnect release so two citizens do not claim the same job
- run safety, player commands, active tasks, professions, and autonomous progression through a priority behavior tree
- assign persistent professions in chat; farmers alternate crops and livestock, fishers use open water, and lumberjacks replant outside protected builds
- reject tree targets inside the base or connected to structural blocks, and score flatter low-terraform sites before building a shelter
- ask an LLM for decisions when enabled
- fall back to safe deterministic behavior when an AI response is invalid

The native 26.2 survival chain has been exercised in live runs through shelter, food fallback, persistent base and farm memory, chest storage, bed placement and sleep, a hydrated wheat farm, the complete iron-age crafting chain, and full iron armor. Controlled server-side tests verified expansion to 48 farmland blocks, batched crop harvest and replanting, a 20-bread reserve, the equipped armor, an 8-ingot reserve, hostile detection, iron-sword combat, and survival on Easy difficulty. Fresh natural-terrain runs also verified 48-block route-time tree detection, collision recovery, safe traversal from a high plains spawn, complete chopping of a six-log oak, emergency refuge construction, protected waiting, side-exit and pillar recovery after sunrise, and an interrupt-driven swim to the surface before drowning. Long unsupervised runs in naturally generated terrain are still experimental. This is not yet a full human-level Minecraft player.

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
ollama pull qwen3.5:9b
```

### One-click Windows launch

After installing Java and Node.js and configuring the DeepSeek API key, double-click
`start-sorim.bat` or run:

```powershell
.\start-sorim.bat
```

The launcher checks the Paper server, starts it when necessary, and then starts Marigo with DeepSeek. In this development workspace
it automatically uses `mc-server-26-2-test` on `127.0.0.1:25566`. In a clean
clone it uses the published `mc-server` directory on `127.0.0.1:25565`.

The launcher enables AI tool selection but does not begin autonomous progression
without permission. Join the server and send `marigo otonom basla` in chat.

Start the bot:

Create a local `.env` file:

```env
USE_LLM=true
LLM_PROVIDER=deepseek
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_MODEL=deepseek-v4-flash
USE_LLM_PLANNER=true
```

Then run `npm start` or `start-sorim.bat`. The ignored `.env` file is loaded automatically.

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

Assign a persistent profession instead of general autonomous progression:

```text
marigo sen artik ciftcisin
marigo madenci olarak calis
marigo meslegini durdur
marigo meslegine devam et
marigo meslegini birak
```

The profession survives reconnects until it is stopped or replaced. Immediate
survival reactions and direct player commands remain above profession work in
the behavior-tree priority order. Free-form multi-step requests are interpreted
into a validated persistent task queue; invalid or unknown tools are rejected.

Optional local Ollama endpoint:

```text
http://127.0.0.1:11434/api/chat
```

Override it if needed:

```powershell
$env:OLLAMA_URL='http://127.0.0.1:11434/api/chat'
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
| `TASK_TOOL_TIMEOUT_MS` | `120000` | Cancel and retry a task tool that never reaches verification |
| `LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info`, or `debug` |
| `AUTONOMOUS_ON_START` | `false` | Start planning immediately instead of waiting for chat |
| `ENABLE_EXPERIMENTAL_26_2` | `false` | Enable the native 26.2 protocol shim |

LLM:

| Variable | Default | Description |
| --- | --- | --- |
| `USE_LLM` | `true` | Keep this enabled for normal AI-agent runs |
| `LLM_PROVIDER` | `deepseek` | `deepseek`, `ollama`, `openai`, `openai-compatible`; `none` is only for diagnostics |
| `LLM_TIMEOUT_MS` | `30000` | AI planning request timeout |
| `CHAT_TIMEOUT_MS` | `45000` | AI chat request timeout; allows a cold local model to load |
| `LLM_MODEL` | empty | Shared model override |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | DeepSeek Chat Completions API base URL |
| `DEEPSEEK_API_KEY` | empty | Secret key stored only in the ignored local `.env` file |
| `DEEPSEEK_MODEL` | `deepseek-v4-flash` | Model used for chat, intent, tool selection, and colony planning |
| `OLLAMA_URL` | `http://127.0.0.1:11434/api/chat` | Ollama native chat and tool-calling endpoint |
| `OLLAMA_MODEL` | `qwen3.5:9b` | Ollama model; 8 GB GPUs should keep context bounded |
| `OLLAMA_CONTEXT_SIZE` | `4096` | Benchmarked default that keeps Qwen 3.5 9B fully on an 8 GB GPU |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `OPENAI_API_KEY` | empty | API key for OpenAI-compatible provider |
| `OPENAI_MODEL` | `gpt-4.1-mini` | OpenAI-compatible model |
| `USE_LLM_PLANNER` | `false` | Let the LLM select high-level tools; `start-sorim.bat` enables it |

The local context comparison and raw measurements are in [docs/benchmarks/ollama-context.md](docs/benchmarks/ollama-context.md). On the tested RTX 5060 8 GB system, `4096` kept Qwen 3.5 9B fully on GPU and was selected as the default.

Copy `.env.example` to `.env` as a starting point. Sorim loads `.env` automatically and Git ignores it.

## 9. Colony Mode

Run the two-agent experiment:

```powershell
$env:MC_PORT='25566'
$env:COLONY_ALPHA='Bot_Mico'
$env:COLONY_BETA='Bot_Mira'
$env:COLONY_ALPHA_ROLE='lumberjack'
$env:COLONY_BETA_ROLE='miner'
npm run colony
```

When `COLONY_CENTER` is omitted, the runtime derives the settlement center from the bots' actual spawn positions. Set an explicit center only for a prepared test area or an established settlement. `COLONY_SEED_RESOURCES=true` also requires both bot usernames to have server command permission; it is intended only for controlled tests.

The colony runtime now has one `ColonyBrain`, a compact shared `ColonyBlackboard`, a persistent scheduler, task and resource leases, verified completion evidence, and one local safety behavior tree per body. The LLM proposes strategic work orders only. Hunger, drowning, nearby hostiles, movement cancellation, and task verification remain deterministic and local. A timed-out or disconnected worker releases its assignment for retry or reassignment.

`CharacterRegistry` persists each citizen independently. The first profiles are `Bot_Mico` (`Mico` / `Miço`, lumberjack) and `Bot_Mira` (miner). Addressing `Miço` routes the reply only to Miço and supplies his stable personality to the dialogue prompt. Personality changes language and safe preferences; it cannot override survival rules.

Supported role profiles include `builder`, `farmer`, `rancher`, `miner`, `lumberjack`, `fisher`, and `quartermaster`; `farmer_miner` remains as the legacy two-agent MVP role. Colony mode is experimental and does not replace solo progression.

The next colony architecture uses one shared AI brain for high-level planning while every bot keeps its own sensors, behavior tree, safety reflexes, identity, memories, profession, and task execution state. The staged implementation plan, including named personalities such as `Bot_Mico`, leadership elections, succession, and memorial behavior, is documented in [docs/COLONY_ROADMAP.md](docs/COLONY_ROADMAP.md).

Solo survival remains the first regression gate: one bot must independently reach a verified starter base and iron age before colony coordination can be considered stable. The same physical skills and local safety rules are shared by both modes; colony services are never a solo dependency.

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
marigo yanima gel
marigo beni koru
marigo burayi koru
marigo benimle savas
marigo Steve'i oldur
marigo dur
marigo agac kes
```

`follow` and `guard` are persistent directives: they survive ordinary task loops
and reconnects until the player says `dur` or replaces them. `come` is a one-time,
distance-verified movement task. Safety reactions such as eating, surfacing, and
combat remain above all three behaviors.

Ambiguous actionable requests are not guessed. Sorim asks one short clarification
question, persists it for five minutes, and accepts the player's next answer without
requiring the bot name again. For example, `marigo onu oldur` asks for a target;
replying `zombi` resolves the original request. `dur`, `iptal`, or `cancel` abandons
the pending request.

DeepSeek can also compose a new profession from Sorim's registered tools:

```text
marigo artik orman bekcisisin; guvenli agaclari kes, fidan dik ve 32 odunu depola
```

Generated professions are schema-checked, persisted, and rejected if they request
an unknown tool or invalid arguments. This composes existing body skills; it does
not allow the model to generate or execute JavaScript at runtime.

For a reusable request that has no named skill, the AI may create a declarative
dynamic skill. The sandbox accepts at most 12 steps and three repetitions per
step and validates every step against the normal tool registry. If registered
tools are insufficient, the model may instead emit bounded Minecraft bytecode:
relative movement, looking, mining, placing, and waiting. Bytecode is limited to
an eight-block radius, six vertical blocks, 32 operations, 16 mutations, and 60
seconds, with an explicit mutable-block capability list and required world-state
postconditions. Skills start in `testing`, become reusable only after task and
world verification, and are disabled after a failed execution.

Player combat, entity interaction, player following, absolute coordinates,
colony operations, redstone and explosive placement, protected-area changes,
shell commands, filesystem access, network access, process execution, and
runtime JavaScript are forbidden inside generated skills.

Player combat is opt-in. A duel uses a bounded number of strikes and stops at the
bot's critical-health threshold; lethal mode is selected only from explicit kill
or to-the-death wording. Combat selects a bow with ammunition at range, an axe
against a shielded target, and a sword for ordinary melee; it uses weapon
cooldowns, shield recovery, sprint pursuit, safe strafing, and terrain-checked
retreats. Explicit commands such as `marigo zombiyi oldur` lock a visible mob by
entity ID and verify that it leaves the world. `marigo dur` cancels combat
immediately.

The clarification-to-combat flow has a Paper 26.2 live fixture. Start the 26.2
server and Sorim, grant `ClarifyTester` operator permission on the local test
server, then run:

```powershell
$env:MC_HOST='127.0.0.1'
$env:MC_PORT='25566'
$env:MC_VERSION='26.2'
npm run fixture:clarification
```

The fixture verifies the clarification question, an unaddressed follow-up answer,
target locking, and the final entity removal.

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

### Independent movement benchmark

The movement benchmark builds a repeatable course and uses a second Mineflayer
client to measure the actor from the server's point of view. It checks flat
walking, a diagonal one-block step, a shallow pit exit, an uneven slope, and a
two-block wall stop:

```powershell
$env:MC_HOST='127.0.0.1'
$env:MC_PORT='25566'
$env:MC_VERSION='26.2'
npm run benchmark:movement
```

The command fails when the actor reports movement without observed displacement,
stays airborne without progress, exceeds the walking speed limit, or remains
desynchronized from the observer. Machine-readable and Markdown reports are
written to `artifacts/movement/latest.json` and `artifacts/movement/latest.md`.
The generated artifacts are intentionally excluded from Git.

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
