require('./logger').installConsoleFilter();
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('./protocol26Shim');

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');

const { askForToolCall, askForChatReply, interpretPlayerIntent } = require('./llm');
const SkillTree = require('./skillTree');
const movement = require('./skills/movement');
const survival = require('./skills/survival');
const storage = require('./skills/storage');
const shelter = require('./skills/shelter');
const memory = require('./skills/memory');
const homestead = require('./skills/homestead');
const actionControl = require('./skills/actionControl');
const toolRegistry = require('./toolRegistry');
const SensorManager = require('./perception/sensorManager');
const Blackboard = require('./agent/blackboard');
const TaskQueue = require('./agent/taskQueue');
const taskVerifier = require('./agent/taskVerifier');
const { PreconditionResolver } = require('./agent/preconditionResolver');
const persistentMemory = require('./agent/persistentMemory');
const DirectiveManager = require('./agent/directiveManager');
const ProfessionManager = require('./professions/professionManager');
const { createRootTree } = require('./agent/behaviorTree/rootTree');
const blockPolicy = require('./safety/blockPolicy');

const BOT_NAME = process.env.MC_USERNAME || 'marigo';
const HOST = process.env.MC_HOST || 'localhost';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION || '26.2';
const LOOP_DELAY_MS = Number(process.env.LOOP_DELAY_MS || 1500);
const TASK_TOOL_TIMEOUT_MS = Number(process.env.TASK_TOOL_TIMEOUT_MS || 120000);
const AUTONOMOUS_TOOL_TIMEOUT_MS = Number(process.env.AUTONOMOUS_TOOL_TIMEOUT_MS || 600000);
const USE_LLM_PLANNER = process.env.USE_LLM_PLANNER === 'true';
const STOP_AT_LEVEL = String(process.env.STOP_AT_LEVEL || '').trim();

memory.initialize(BOT_NAME);
persistentMemory.initialize(BOT_NAME);

const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: BOT_NAME,
    version: VERSION
});

install26_2PacketFallbacks(bot);
install26_2VelocityShim(bot);
bot.loadPlugin(pathfinder);

const skillTree = new SkillTree();
const sensors = new SensorManager(bot, { getBase: memory.getBase });
const blackboard = new Blackboard();
const taskQueue = new TaskQueue(persistentMemory, { preconditionResolver: new PreconditionResolver() });
const professionManager = new ProfessionManager(persistentMemory, {
    tools: toolRegistry.TOOL_DEFINITIONS.filter(tool => ![
        'follow_player', 'move_near', 'fight_mob', 'evade_hostile',
        'build_blueprint', 'build_showcase', 'recover_items'
    ].includes(tool.name)),
    validateToolCall: call => toolRegistry.validateToolCall(
        toolRegistry.normalizeToolCall(call),
        toolRegistry.TOOL_DEFINITIONS
    )
});
const directiveManager = new DirectiveManager(persistentMemory);
const behaviorTree = createRootTree({ taskQueue, professionManager });
let running = true;
let busy = false;
let chatBusy = false;
const conversationWindows = new Map();
const CHAT_CONTINUATION_MS = Number(process.env.CHAT_CONTINUATION_MS || 120000);
const SOLO_CHARACTER = {
    shortName: 'Marigo',
    displayName: 'Marigo',
    traits: { sociability: 0.82, curiosity: 0.74, humor: 0.45, discipline: 0.68 },
    speech: { tone: 'warm, curious, and conversational', verbosity: 'medium' },
    values: ['friendship', 'cooperation', 'survival', 'honesty']
};
let queuedUserCommand = null;
let autonomousMode = process.env.AUTONOMOUS_ON_START === 'true';
let cancelRequested = false;
let lastError = null;
let activeToolName = null;
let pendingSafetyCall = null;
let activeBehaviorSource = null;
let currentLevelId = 'BOOT';
let lastIpcTelemetryAt = 0;
let lastPhysicsPosition = null;
let lastKnownInventoryCount = 0;

bot.once('spawn', async () => {
    console.log(`[BOOT] ${BOT_NAME} spawned. AI body runtime started.`);
    movement.configure(bot);
    install26_2AttackShim(bot);
    await sleep(3000);
    loop().catch(error => {
        console.log('[FATAL]', error.message);
        shutdown();
    });
});

bot.on('physicsTick', () => {
    if (!bot.entity?.position) return;
    lastPhysicsPosition = bot.entity.position.clone();
    lastKnownInventoryCount = (bot.inventory?.items?.() || [])
        .reduce((sum, item) => sum + item.count, 0);
    if (typeof process.send !== 'function') return;
    const now = Date.now();
    if (now - lastIpcTelemetryAt < 250) return;
    lastIpcTelemetryAt = now;
    const inventory = {};
    for (const item of bot.inventory?.items?.() || []) {
        inventory[item.name] = (inventory[item.name] || 0) + item.count;
    }
    process.send({
        type: 'sorimTelemetry',
        sample: {
            at: now,
            level: currentLevelId,
            position: point(bot.entity.position),
            velocity: point(bot.entity.velocity),
            onGround: Boolean(bot.entity.onGround),
            controls: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
                .filter(control => bot.controlState?.[control]),
            health: bot.health,
            food: bot.food,
            inventory,
            activeTool: activeToolName,
            behaviorSource: activeBehaviorSource
        }
    });
});

bot.on('chat', async (username, message) => {
    if (username === bot.username) return;
    sensors.recordChat(username, message);
    const lower = message.toLowerCase();
    const addressed = lower.includes(BOT_NAME.toLowerCase()) || lower.includes('marigo');
    const continuing = (conversationWindows.get(username) || 0) > Date.now();
    if (!addressed && !continuing) return;
    if (looksLikeAdminCommand(lower)) return;
    conversationWindows.set(username, Date.now() + CHAT_CONTINUATION_MS);

    persistentMemory.rememberPlayer(username);
    persistentMemory.addConversation(username, 'user', message);
    blackboard.set('owner', username);
    const observation = observe();
    if (lower.includes('status') || lower.includes('durum')) {
        const pos = observation.position;
        const profession = professionManager.current()?.id || 'none';
        const directive = directiveManager.current()?.type || 'none';
        const task = taskQueue.summary()?.goal || 'none';
        bot.chat(`Mode:${autonomousMode ? 'auto' : 'manual'} job:${profession} directive:${directive} task:${task} xyz:${pos.x},${pos.y},${pos.z} health:${bot.health.toFixed(1)} food:${bot.food}`);
        return;
    }

    const command = parseUserCommand(username, lower);
    if (command) {
        applyUserCommand(command);
        bot.chat(command.reply);
        persistentMemory.addConversation(username, 'assistant', command.reply);
        return;
    }

    if (chatBusy) {
        bot.chat('Bir saniye, onceki mesaji dusunuyorum.');
        return;
    }

    chatBusy = true;
    try {
        const aiIntent = await interpretPlayerIntent({
            username,
            message,
            observation,
            profession: professionManager.current(),
            task: taskQueue.summary(),
            tools: toolRegistry.TOOL_DEFINITIONS
        });
        const intentReply = applyAiIntent(username, aiIntent);
        if (intentReply) {
            bot.chat(intentReply);
            persistentMemory.addConversation(username, 'assistant', intentReply);
            return;
        }

        const level = skillTree.getLevel(observation);
        const reply = await askForChatReply({
            username,
            message,
            observation,
            level,
            profession: professionManager.current(),
            task: taskQueue.summary(),
            playerMemory: persistentMemory.getPlayer(username),
            conversation: persistentMemory.getConversation(username, 14),
            episodes: persistentMemory.getRelevantEpisodes(8),
            character: SOLO_CHARACTER
        });
        for (const part of splitChat(reply)) {
            bot.chat(part);
            await sleep(350);
        }
        persistentMemory.addConversation(username, 'assistant', reply);
    } catch (error) {
        console.log('[CHAT_ERROR]', error.message);
        bot.chat('Duydum ama cevap verirken takildim.');
    } finally {
        chatBusy = false;
    }
});

bot.on('kicked', reason => console.log('[KICKED]', reason));
bot.on('error', error => console.log('[BOT_ERROR]', error.message));
bot.on('forcedMove', () => {
    const correctionDistance = lastPhysicsPosition && bot.entity?.position
        ? bot.entity.position.distanceTo(lastPhysicsPosition)
        : Infinity;
    const exit = memory.getSurfaceExit();
    const distance = exit && bot.entity?.position
        ? Math.hypot(bot.entity.position.x - exit.x, bot.entity.position.z - exit.z)
        : 0;
    if (distance > 24) {
        memory.clearSurfaceExit();
        memory.clearMineRoute();
        console.log(`[PHYSICS] cleared stale recovery route after forced move distance=${distance.toFixed(1)}`);
    }
    if (Number.isFinite(correctionDistance) && correctionDistance >= 0.5) {
        console.log(
            `[PHYSICS] forced move correction=${Number.isFinite(correctionDistance)
                ? correctionDistance.toFixed(2)
                : 'unknown'}`
        );
    }
    if (busy && correctionDistance >= 2.5) haltCurrentAction('server forced move');
});
bot.on('sorimVelocity', event => {
    const velocity = event.velocity;
    if (Math.hypot(velocity.x, velocity.z) < 0.08 && Math.abs(velocity.y) < 0.08) return;
    console.log(
        `[PHYSICS] knockback velocity=` +
        `${velocity.x.toFixed(3)},${velocity.y.toFixed(3)},${velocity.z.toFixed(3)}`
    );
});
bot.on('death', () => {
    console.log('[DEATH] Bot died; cancelling the active action before respawn.');
    if (lastKnownInventoryCount > 0 || !memory.getLastDeath()) {
        memory.setLastDeath(lastPhysicsPosition || bot.entity?.position, Date.now());
    }
    pendingSafetyCall = null;
    memory.clearSurfaceExit();
    haltCurrentAction('death');
});
bot.on('end', () => {
    running = false;
    console.log('[END] Bot connection closed.');
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const safetyWatchdog = setInterval(() => {
    if (!running || !busy || cancelRequested || !bot.entity || bot.health <= 0) return;
    if (survival.needsAir(bot) && activeToolName !== 'escape_water') {
        console.log(`[SAFETY_INTERRUPT] cancelling=${activeToolName || 'unknown'} danger=drowning`);
        pendingSafetyCall = toolRegistry.normalizeToolCall({
            action: 'escape_water',
            reason: 'Oxygen safety override'
        });
        haltCurrentAction('drowning');
        return;
    }
    if (['fight_mob', 'evade_hostile', 'escape_water'].includes(activeToolName)) return;
    // A completed refuge is safe. An unfinished refuge is still exposed and
    // must be interruptible when a hostile approaches during digging.
    if (survival.isEmergencyShelter(bot)) return;
    const threat = survival.nearestHostile(bot, 12);
    if (!survival.shouldInterruptForThreat(bot, threat)) return;
    if (activeToolName === 'return_base' && threat.distance > 3.2) return;
    if (activeToolName === 'emergency_shelter' && threat.distance > 3.2) return;

    console.log(
        `[SAFETY_INTERRUPT] cancelling=${activeToolName || 'unknown'} ` +
        `threat=${threat.name} distance=${threat.distance.toFixed(1)}`
    );
    pendingSafetyCall = toolRegistry.normalizeToolCall(
        survival.chooseThreatAction(bot, threat, bot.health)
    );
    haltCurrentAction(`hostile ${threat.name}`);
}, 300);
safetyWatchdog.unref();

async function loop() {
    while (running) {
        await sleep(LOOP_DELAY_MS);
        if (!running) break;
        if (!bot.entity || busy || bot.health <= 0) continue;

        busy = true;
        try {
            movement.resyncCollision(bot);
            await shelter.ensureBaseEgress(bot);
            const observation = observe();
            const level = skillTree.getLevel(observation);
            currentLevelId = level.id;
            if (STOP_AT_LEVEL && level.id === STOP_AT_LEVEL) {
                console.log(`[GATE_REACHED] level=${level.id} inv=${observation.inventoryText}`);
                shutdown();
                break;
            }
            if (observation.base) blockPolicy.syncBaseProtection(observation.base);
            const commandCall = queuedUserCommand;
            queuedUserCommand = null;

            const directiveCall = directiveManager.nextTool(bot, observation);
            const directedMode = autonomousMode || Boolean(
                directiveCall || commandCall || taskQueue.active() ||
                professionManager.current()?.status === 'active'
            );
            const immediate = pendingSafetyCall || (directedMode
                ? survival.chooseImmediateAction(bot, observation, level)
                : choosePassiveSafetyAction(observation, level));
            pendingSafetyCall = null;
            const safetyCall = immediate ? toolRegistry.normalizeToolCall(immediate) : null;
            const availableTools = toolRegistry.constrainToolsForObservation(
                toolRegistry.toolsForLevel(level),
                level,
                observation
            );
            let source = 'fallback';
            let toolCall = null;

            const hasDirectedWork = Boolean(commandCall || directiveCall || taskQueue.active() || professionManager.current());
            const deterministicProgression = autonomousMode && !safetyCall && !hasDirectedWork &&
                level.id !== 'L21_STABLE_SURVIVAL';
            if (deterministicProgression) {
                toolCall = toolRegistry.fallbackToolCall(skillTree, observation, level);
                source = 'skill-tree';
            }

            if (autonomousMode && !safetyCall && !hasDirectedWork && !toolCall && USE_LLM_PLANNER) {
                const aiCall = await askForToolCall({
                    level,
                    observation,
                    tools: availableTools
                });
                const validAiCall = toolRegistry.validateToolCall(
                    toolRegistry.normalizeToolCall(aiCall),
                    availableTools
                );
                source = validAiCall ? 'ai' : 'fallback';
                if (aiCall && !validAiCall) {
                    console.log(`[AI_REJECTED] level=${level.id} raw=${JSON.stringify(aiCall)}`);
                }
                toolCall = validAiCall;
            }

            if (autonomousMode && !safetyCall && !hasDirectedWork) {
                toolCall = toolCall || toolRegistry.fallbackToolCall(skillTree, observation, level);
            }

            blackboard.update({
                observation,
                worldState: observation.worldState,
                safetyCall,
                immediateCommand: commandCall,
                autonomous: autonomousMode,
                lastError
            });
            const treeResult = await behaviorTree.tick({
                observation,
                safetyCall,
                commandCall,
                directiveCall,
                autonomousCall: toolCall,
                autonomousSource: source,
                bot
            });
            const decision = treeResult.value;
            activeBehaviorSource = decision?.source || null;
            console.log(`[BEHAVIOR] source=${activeBehaviorSource} level=${level.id} tool=${JSON.stringify(decision?.toolCall)} inv=${observation.inventoryText}`);
            const beforeTask = activeBehaviorSource === 'task' ? taskVerifier.capture(bot, observation) : null;
            const executionResult = activeBehaviorSource === 'task'
                ? await executeTaskTool(decision?.toolCall)
                : await executeToolWithTimeout(
                    decision?.toolCall,
                    AUTONOMOUS_TOOL_TIMEOUT_MS,
                    'Autonomous'
                );
            // Some skills recover internally from an aborted movement promise.
            // Do not let that swallow the watchdog cancellation and permanently
            // disable later survival interrupts.
            if (cancelRequested) {
                cancelRequested = false;
                lastError = null;
                movement.stop(bot);
                continue;
            }
            if (activeBehaviorSource === 'task') {
                await sleep(350);
                const afterObservation = observe();
                const verification = taskVerifier.verify(
                    decision.toolCall,
                    beforeTask,
                    taskVerifier.capture(bot, afterObservation),
                    { bot, executionResult, beforeObservation: observation, afterObservation }
                );
                if (!verification.ok) {
                    throw new taskVerifier.TaskVerificationError(verification.reason, verification.details);
                }
                console.log(`[TASK_VERIFIED] tool=${decision.toolCall.tool} reason=${verification.reason}`);
                const completion = taskQueue.completeCurrentStep(verification);
                if (completion?.taskCompleted && completion.task.requestedBy &&
                    persistentMemory.recordProactiveReport(`task_complete:${completion.task.id}`)) {
                    bot.chat(`${completion.task.requestedBy}, ${completion.task.goal} gorevini tamamladim.`);
                }
            }
            sensors.record('tool_completed', {
                source: activeBehaviorSource,
                tool: decision?.toolCall?.tool
            }, activeBehaviorSource === 'task' ? 0.55 : 0.2);
            lastError = null;
        } catch (error) {
            if (cancelRequested) {
                cancelRequested = false;
                lastError = null;
                movement.stop(bot);
                continue;
            }
            if (isExpectedMovementCancel(error)) {
                lastError = null;
                continue;
            }
            lastError = error.message;
            if (activeBehaviorSource === 'task') {
                const failure = taskQueue.failCurrentStep(error);
                if (failure?.taskFailed && failure.task.requestedBy &&
                    persistentMemory.recordProactiveReport(`task_failed:${failure.task.id}`)) {
                    bot.chat(`${failure.task.requestedBy}, gorev durdu: ${error.message}`.slice(0, 220));
                }
            }
            sensors.record('tool_failed', { source: activeBehaviorSource, error: error.message }, 0.65);
            console.log('[STEP_ERROR]', error.message);
            movement.stop(bot);
        } finally {
            activeBehaviorSource = null;
            busy = false;
        }
    }
}

function observe() {
    return sensors.capture(lastError, {
        hasUsableChest: storage.hasChestNearby(bot),
        hasPlacedCraftingTable: memory.hasPlacedBlock('crafting_table'),
        hasPlacedFurnace: memory.hasPlacedBlock('furnace'),
        hasBed: homestead.hasBed(bot),
        farmReady: homestead.hasFarm(bot),
        hasMatureCrop: homestead.hasMatureCrop(bot),
        farmCapacity: homestead.farmCapacity(bot),
        growingCrops: homestead.growingCropCount(bot),
        storageReady: !storage.isTemporarilyUnavailable(),
        survivalReady: true,
        profession: professionManager.current(),
        activeTask: taskQueue.summary()
    });
}

function install26_2AttackShim(bot) {
    if (VERSION !== '26.2' && process.env.ENABLE_EXPERIMENTAL_26_2 !== 'true') return;
    if (bot._marigo26_2AttackShimInstalled || typeof bot.attack !== 'function') return;
    bot._marigo26_2AttackShimInstalled = true;
    const originalAttack = bot.attack.bind(bot);

    bot.attack = function attack26_2(target, swing = true) {
        if (!target?.id || !bot._client) return originalAttack(target, swing);
        bot._client.write('attack', { entityId: target.id });
        if (swing) bot.swingArm();
    };
}

function countInventory() {
    const counts = {};
    for (const item of bot.inventory.slots.filter(Boolean)) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    if (bot.heldItem) {
        counts[bot.heldItem.name] = Math.max(counts[bot.heldItem.name] || 0, bot.heldItem.count);
    }
    return counts;
}

function inventoryText(inventory) {
    const text = Object.entries(inventory)
        .map(([name, count]) => `${name}:${count}`)
        .join(', ');
    return text || 'empty';
}

function scanUsefulBlocks(maxDistance) {
    const logNames = Object.keys(bot.registry.blocksByName || {})
        .filter(name => name.endsWith('_log'));
    const names = [
        ...logNames,
        'stone', 'cobblestone', 'coal_ore', 'iron_ore', 'deepslate_iron_ore',
        'crafting_table', 'furnace', 'chest', 'torch'
    ];
    const usefulNames = new Set(names);
    const logPositions = bot.findBlocks({
        matching: block => Boolean(block?.name?.endsWith('_log')),
        maxDistance,
        count: 32
    });
    const generalPositions = bot.findBlocks({
        matching: block => usefulNames.has(block?.name),
        maxDistance,
        count: 96
    });
    const positions = [...logPositions, ...generalPositions]
        .filter((position, index, all) =>
            all.findIndex(candidate => candidate.equals(position)) === index
        );

    return positions
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .map(block => ({
            name: block.name,
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
            distance: Number(block.position.distanceTo(bot.entity.position).toFixed(1))
        }))
        .sort((a, b) => {
            const logPriority = Number(b.name.endsWith('_log')) - Number(a.name.endsWith('_log'));
            return logPriority || a.distance - b.distance;
        })
        .slice(0, 24);
}

function parseUserCommand(username, lowerMessage) {
    const message = lowerMessage
        .replace(BOT_NAME.toLowerCase(), '')
        .replace('marigo', '')
        .trim();
    const foldedMessage = foldTurkish(message);

    if (includesAny(message, [
        'komut',
        'komutlar',
        'commands',
        'help'
    ])) {
        return {
            type: 'help',
        reply: 'Komutlar: beni takip et, yanima gel, beni/burayi koru, dur, odun veya tas topla, yemek bul, meslek ver, otonom basla, durum.'
        };
    }

    if ((/\b(?:eve|base|home)\b/.test(foldedMessage) &&
        /\b(?:don|git|gel|return|go)\b/.test(foldedMessage))) {
        return {
            type: 'tool',
            toolCall: { tool: 'return_base', args: {}, reason: 'base konumuna don' },
            reply: 'Tamam, base konumuna donuyorum.'
        };
    }

    if (/sandik|sandig|chest|depo/.test(foldedMessage) &&
        /duzenle|birak|koy|store|deposit/.test(foldedMessage)) {
        return {
            type: 'tool',
            toolCall: { tool: 'organize_storage', args: {}, reason: 'fazla esyalari sandiga yerlestir' },
            reply: 'Tamam, fazla esyalari sandiga yerlestiriyorum.'
        };
    }

    if (includesAny(message, [
        'meslegini birak',
        'meslegi birak',
        'meslekten ayril',
        'quit profession',
        'leave profession'
    ])) {
        return {
            type: 'profession_stop',
            reply: 'Tamam, meslegimi biraktim ve yeni gorev bekliyorum.'
        };
    }

    if (includesAny(message, [
        'meslegini durdur',
        'meslege ara ver',
        'pause profession'
    ])) {
        return {
            type: 'profession_pause',
            reply: 'Tamam, meslek rutinime ara verdim.'
        };
    }

    if (includesAny(message, [
        'meslegine devam et',
        'meslege devam et',
        'resume profession'
    ])) {
        return {
            type: 'profession_resume',
            reply: 'Tamam, meslek rutinime devam ediyorum.'
        };
    }

    const professionMatch = foldedMessage.match(
        /(?:artik\s+)?(?:sen\s+)?(?:bir\s+)?(ciftci|yemekci|hayvanci|madenci|oduncu|balikci|insaatci|muhafiz|depocu|farmer|rancher|miner|lumberjack|fisher|builder|guard|quartermaster)(?:\s+ol|\s+olacaksin|\s+olarak calis)?/i
    );
    if (professionMatch && includesAny(foldedMessage, ['ol', 'calis', 'artik', 'profession', 'meslek'])) {
        return {
            type: 'profession_assign',
            profession: professionMatch[1],
            username,
            reply: `${professionMatch[1]} meslegini kalici gorevim olarak aliyorum.`
        };
    }

    if (includesAny(message, [
        'otonom basla',
        'otonom başla',
        'kendi basla',
        'kendi başla',
        'devam et',
        'auto start',
        'start autonomous'
    ])) {
        return {
            type: 'auto_start',
            reply: 'Tamam, otonom plana basliyorum.'
        };
    }

    if (includesAny(message, [
        'otonom dur',
        'otonom kapat',
        'auto stop',
        'stop autonomous'
    ])) {
        return {
            type: 'auto_stop',
            reply: 'Tamam, otonom plani durdurdum. Komut bekliyorum.'
        };
    }

    if (includesAny(message, [
        'takip et',
        'beni takip',
        'follow me',
        'come with me',
        'gel benimle'
    ])) {
        return {
            type: 'follow',
            username,
            reply: 'Tamam, seni takip ediyorum.'
        };
    }

    if (includesAny(foldedMessage, [
        'yanima gel',
        'buraya gel',
        'come here',
        'come to me'
    ])) {
        return {
            type: 'come',
            username,
            reply: 'Tamam, yanina geliyorum.'
        };
    }

    if (includesAny(foldedMessage, [
        'beni koru',
        'yanimda nobet tut',
        'guard me',
        'protect me'
    ])) {
        return {
            type: 'guard',
            username,
            target: 'player',
            reply: 'Tamam, yaninda kalip seni koruyacagim.'
        };
    }

    if (includesAny(foldedMessage, [
        'burayi koru',
        'burada nobet tut',
        'guard here',
        'protect this place'
    ])) {
        return {
            type: 'guard',
            username,
            target: 'position',
            reply: 'Tamam, bu noktada nobet tutacagim.'
        };
    }

    if (includesAny(message, [
        'takibi birak',
        'takibi bırak',
        'dur',
        'bekle',
        'stop',
        'wait'
    ])) {
        return {
            type: 'stop',
            reply: 'Tamam, duruyorum ve mevcut komutu iptal ediyorum.'
        };
    }

    if (!isMultiStepRequest(message) && includesAny(message, [
        'agac kes',
        'ağaç kes',
        'odun topla',
        'wood',
        'chop tree',
        'cut tree'
    ])) {
        return {
            type: 'tool',
            toolCall: {
                tool: 'mine_block',
                args: { target: 'any_log' },
                reason: `Player ${username} requested wood`
            },
            reply: 'Tamam, en yakin agaci kesmeye gidiyorum.'
        };
    }

    if (!isMultiStepRequest(message) && includesAny(message, [
        'tas topla',
        'taş topla',
        'stone',
        'cobblestone',
        'kaya topla'
    ])) {
        return {
            type: 'tool',
            toolCall: {
                tool: 'collect_stone',
                args: { count: 16 },
                reason: `Player ${username} requested stone`
            },
            reply: 'Tamam, guvenli merdivenle tas toplamaya basliyorum.'
        };
    }

    if (includesAny(message, [
        'build showcase',
        'showcase build',
        'hepsini yap',
        'tum buildleri yap',
        'tüm buildleri yap'
    ])) {
        return {
            type: 'tool',
            toolCall: {
                tool: 'build_showcase',
                args: {},
                reason: `Player ${username} requested creative build showcase`
            },
            reply: 'Tamam, creative showcase alanini kuruyorum.'
        };
    }

    const buildMatch = message.match(/\b(?:build|inşa|insa|yap)\s+([a-z0-9_-]+)/i);
    if (buildMatch) {
        return {
            type: 'tool',
            toolCall: {
                tool: 'build_blueprint',
                args: { name: buildMatch[1] },
                reason: `Player ${username} requested blueprint ${buildMatch[1]}`
            },
            reply: `${buildMatch[1]} blueprintini creative modda kuruyorum.`
        };
    }

    if (!isMultiStepRequest(message) && includesAny(message, [
        'yemek bul',
        'food',
        'find food'
    ])) {
        return {
            type: 'tool',
            toolCall: {
                tool: 'find_food',
                args: {},
                reason: `Player ${username} requested food`
            },
            reply: 'Tamam, yemek kaynagi ariyorum.'
        };
    }

    return null;
}

function looksLikeAdminCommand(lowerMessage) {
    const stripped = lowerMessage.replace(BOT_NAME.toLowerCase(), '').replace('marigo', '').trim();
    const firstWord = stripped.split(/\s+/)[0];
    return [
        'op',
        'deop',
        'tp',
        'teleport',
        'clear',
        'give',
        'fill',
        'setblock',
        'difficulty',
        'gamerule',
        'time',
        'weather',
        'kill',
        'effect',
        'gamemode',
        'summon'
    ].includes(firstWord) ||
        ['gave', 'removed', 'teleported', 'changed', 'set', 'made', 'killed', 'applied']
            .includes(firstWord);
}

function applyUserCommand(command) {
    if (command.type === 'help') return;

    if (command.type === 'auto_start') {
        autonomousMode = true;
        persistentMemory.pauseProfession(false);
        directiveManager.stop();
        queuedUserCommand = null;
        return;
    }

    if (command.type === 'auto_stop') {
        autonomousMode = false;
        directiveManager.stop();
        queuedUserCommand = null;
        haltCurrentAction();
        return;
    }

    if (command.type === 'follow') {
        autonomousMode = false;
        directiveManager.follow(command.username);
        queuedUserCommand = null;
        taskQueue.cancelAll('replaced by follow directive');
        haltCurrentAction('follow directive');
        return;
    }

    if (command.type === 'come') {
        const entity = bot.players?.[command.username]?.entity;
        if (!entity?.position) return;
        autonomousMode = false;
        directiveManager.stop();
        taskQueue.cancelAll('replaced by come command');
        taskQueue.enqueue({
            goal: `come to ${command.username}`,
            requestedBy: command.username,
            steps: [{
                tool: 'move_near',
                args: { x: entity.position.x, y: entity.position.y, z: entity.position.z, range: 2 },
                reason: `Go to ${command.username}'s requested position`
            }]
        });
        haltCurrentAction('come command');
        return;
    }

    if (command.type === 'guard') {
        const entity = bot.players?.[command.username]?.entity;
        autonomousMode = false;
        taskQueue.cancelAll('replaced by guard directive');
        directiveManager.guard({
            username: command.target === 'player' ? command.username : null,
            anchor: command.target === 'position' ? entity?.position : null,
            assignedBy: command.username,
            range: 5
        });
        haltCurrentAction('guard directive');
        return;
    }

    if (command.type === 'stop') {
        autonomousMode = false;
        directiveManager.stop();
        queuedUserCommand = null;
        taskQueue.cancelAll('stopped by player');
        persistentMemory.pauseProfession(true);
        haltCurrentAction();
        return;
    }

    if (command.type === 'profession_assign') {
        const profile = professionManager.assign(command.profession, command.username);
        if (!profile) return;
        autonomousMode = false;
        directiveManager.stop();
        queuedUserCommand = null;
        taskQueue.cancelAll('replaced by profession assignment');
        haltCurrentAction('profession changed');
        return;
    }

    if (command.type === 'profession_pause') {
        persistentMemory.pauseProfession(true);
        haltCurrentAction('profession paused');
        return;
    }

    if (command.type === 'profession_resume') {
        persistentMemory.pauseProfession(false);
        return;
    }

    if (command.type === 'profession_stop') {
        professionManager.stop();
        haltCurrentAction('profession stopped');
        return;
    }

    if (command.type === 'tool') {
        autonomousMode = false;
        directiveManager.stop();
        queuedUserCommand = null;
        taskQueue.cancelAll('replaced by player command');
        taskQueue.enqueue({
            goal: command.toolCall.reason || command.toolCall.tool,
            requestedBy: blackboard.get('owner'),
            steps: [command.toolCall]
        });
    }
}

function applyAiIntent(username, intent) {
    if (!intent || intent.intent === 'chat') return null;
    if (intent.intent === 'assign_profession') {
        const profile = professionManager.assign(intent.profession, username);
        if (!profile) return null;
        autonomousMode = false;
        directiveManager.stop();
        taskQueue.cancelAll('replaced by profession assignment');
        haltCurrentAction('profession changed');
        return `Tamam, artik ${profile.id} olarak calisacagim.`;
    }
    if (intent.intent === 'create_profession') {
        const created = professionManager.createAndAssign(intent.professionProfile, username);
        if (!created.ok) return `Bu meslegi guvenli sekilde olusturamadim: ${created.error}`.slice(0, 220);
        autonomousMode = false;
        directiveManager.stop();
        taskQueue.cancelAll('replaced by custom profession assignment');
        haltCurrentAction('custom profession created');
        return `${created.profile.displayName} meslegini ogrendim ve bu isi yapmaya basliyorum.`;
    }
    if (intent.intent === 'stop_profession') {
        professionManager.stop();
        haltCurrentAction('profession stopped');
        return 'Tamam, meslegimi biraktim.';
    }
    if (intent.intent === 'follow') {
        applyUserCommand({ type: 'follow', username });
        return 'Tamam, dur diyene kadar seni takip edecegim.';
    }
    if (intent.intent === 'come') {
        applyUserCommand({ type: 'come', username });
        return 'Tamam, bulundugun noktaya geliyorum.';
    }
    if (intent.intent === 'guard') {
        applyUserCommand({
            type: 'guard',
            username,
            target: intent.target === 'position' ? 'position' : 'player'
        });
        return intent.target === 'position'
            ? 'Tamam, bu noktada nobet tutacagim.'
            : 'Tamam, yaninda kalip seni koruyacagim.';
    }
    if (intent.intent === 'stop') {
        applyUserCommand({ type: 'stop' });
        return 'Tamam, mevcut direktif ve gorevi durdurdum.';
    }
    if (intent.intent === 'create_goal' && Array.isArray(intent.steps) && intent.steps.length > 0) {
        const available = toolRegistry.TOOL_DEFINITIONS;
        const steps = intent.steps
            .map(step => toolRegistry.normalizeToolCall(step))
            .filter(step => toolRegistry.validateToolCall(step, available));
        if (steps.length === 0) return null;
        taskQueue.cancelAll('replaced by new player goal');
        taskQueue.enqueue({
            goal: String(intent.goal || 'player request').slice(0, 120),
            requestedBy: username,
            steps
        });
        autonomousMode = false;
        directiveManager.stop();
        return `Tamam, ${steps.length} adimli gorevi baslatiyorum.`;
    }
    return null;
}

function includesAny(message, needles) {
    return needles.some(needle => {
        if (!needle.includes(' ') && /^[a-z0-9_]+$/i.test(needle)) {
            return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(needle)}([^a-z0-9_]|$)`, 'i')
                .test(message);
        }
        return message.includes(needle);
    });
}

function isMultiStepRequest(message) {
    const folded = foldTurkish(message);
    return [' sonra ', ' ardindan ', ' daha sonra ', ' and then ', ' then ', ', sonra ']
        .some(connector => ` ${folded} `.includes(connector));
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function foldTurkish(value) {
    return String(value || '').toLocaleLowerCase('tr-TR')
        .replace(/[ç]/g, 'c')
        .replace(/[ğ]/g, 'g')
        .replace(/[ıİi]/g, 'i')
        .replace(/[ö]/g, 'o')
        .replace(/[ş]/g, 's')
        .replace(/[ü]/g, 'u');
}

function isExpectedMovementCancel(error) {
    const message = error?.message || '';
    return message.includes('digging aborted') ||
        message.includes('Digging aborted');
}

function choosePassiveSafetyAction(observation, level) {
    const action = survival.chooseImmediateAction(bot, observation, level);
    if (!action) return null;
    const call = toolRegistry.normalizeToolCall(action);
    const passiveSafetyTools = new Set([
        'escape_water', 'fight_mob', 'evade_hostile', 'eat_food', 'escape_pit'
    ]);
    return passiveSafetyTools.has(call?.tool) ? action : null;
}

function haltCurrentAction(reason = 'manual stop') {
    actionControl.cancel(bot, reason);
    cancelRequested = true;
    movement.stop(bot);
    try {
        bot.stopDigging();
    } catch {
        // The bot may not be digging right now.
    }
}

async function executeTool(call) {
    activeToolName = call?.tool || null;
    try {
        return await toolRegistry.executeToolCall(bot, call);
    } finally {
        activeToolName = null;
    }
}

async function executeTaskTool(call) {
    return executeToolWithTimeout(call, TASK_TOOL_TIMEOUT_MS, 'Task');
}

async function executeToolWithTimeout(call, timeoutMs, label) {
    let timeout = null;
    let timeoutError = null;
    const execution = executeTool(call);
    const timedOut = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
            cancelActiveTool(`${label.toLowerCase()} timeout: ${call?.tool || 'unknown'}`);
            timeoutError = new Error(`${label} tool timed out after ${timeoutMs}ms: ${call?.tool || 'unknown'}`);
            reject(timeoutError);
        }, timeoutMs);
    });
    try {
        return await Promise.race([execution, timedOut]);
    } catch (error) {
        if (error === timeoutError) {
            await Promise.race([
                execution.catch(() => undefined),
                sleep(30000)
            ]);
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function cancelActiveTool(reason) {
    actionControl.cancel(bot, reason);
    movement.stop(bot);
    try {
        bot.stopDigging();
    } catch {
        // The task may not currently be digging.
    }
}

function shutdown() {
    if (!running) return;
    running = false;
    console.log('[SHUTDOWN] Stopping bot.');
    haltCurrentAction('shutdown');
    try {
        memory.flush();
        persistentMemory.flush();
    } catch (error) {
        console.log('[MEMORY] shutdown save failed:', error.message);
    }
    try {
        bot.quit('Goodbye');
    } catch {
        // Bot was already gone.
    }
}

function splitChat(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return ['Duydum ama su an iyi cevap uretemedim.'];

    const chunks = [];
    let remaining = clean;
    const limit = 220;
    while (remaining.length > limit) {
        let cut = remaining.lastIndexOf(' ', limit);
        if (cut < 80) cut = limit;
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks.slice(0, 3);
}

function point(value) {
    return value ? {
        x: Number(value.x.toFixed(3)),
        y: Number(value.y.toFixed(3)),
        z: Number(value.z.toFixed(3))
    } : null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
