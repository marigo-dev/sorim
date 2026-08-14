require('./logger').installConsoleFilter();
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('./protocol26Shim');

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const movement = require('./skills/movement');
const actionControl = require('./skills/actionControl');
const survival = require('./skills/survival');
const sharedStorage = require('./skills/sharedStorage');
const colonyMemory = require('./skills/colonyMemory');
const worldMemory = require('./skills/memory');
const colonyTasks = require('./skills/colonyTasks');
const toolRegistry = require('./toolRegistry');
const taskVerifier = require('./agent/taskVerifier');
const ColonyBlackboard = require('./agent/colonyBlackboard');
const ColonyScheduler = require('./agent/colonyScheduler');
const ColonyBrain = require('./agent/colonyBrain');
const CharacterRegistry = require('./characters/characterRegistry');
const { createColonyBodyTree } = require('./agent/behaviorTree/colonyBodyTree');
const { askForChatReply, askForColonyPlan } = require('./llm');

const HOST = process.env.MC_HOST || 'localhost';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION || '26.2';
const CONFIGURED_CENTER = process.env.COLONY_CENTER
    ? colonyTasks.parseCenter(process.env.COLONY_CENTER)
    : null;
let CENTER = CONFIGURED_CENTER || new Vec3(0, 64, 0);
const RUNTIME_MS = Number(process.env.COLONY_RUNTIME_MS || 180000);
const LOOP_DELAY_MS = Number(process.env.COLONY_LOOP_DELAY_MS || 1200);
const SEED_RESOURCES = process.env.COLONY_SEED_RESOURCES === 'true';
const BRAIN_INTERVAL_MS = Number(process.env.COLONY_BRAIN_INTERVAL_MS || 30000);
const COLONY_TOOL_TIMEOUT_MS = Number(process.env.COLONY_TOOL_TIMEOUT_MS || 90000);

const STRATEGIC_TOOL_NAMES = new Set([
    'mine_block', 'collect_stone', 'ensure_base', 'maintain_food_supply',
    'care_for_animals', 'fish', 'prepare_mining_kit', 'mine_iron',
    'organize_storage', 'deposit_shared_storage', 'build_colony_marker'
]);
const STRATEGIC_TOOLS = toolRegistry.TOOL_DEFINITIONS.filter(tool => STRATEGIC_TOOL_NAMES.has(tool.name));

const AGENTS = [
    {
        id: 'citizen_mico',
        name: process.env.COLONY_ALPHA || 'Bot_Mico',
        role: process.env.COLONY_ALPHA_ROLE || 'lumberjack',
        coordinator: true,
        base: null
    },
    {
        id: 'citizen_mira',
        name: process.env.COLONY_BETA || 'Bot_Mira',
        role: process.env.COLONY_BETA_ROLE || 'miner',
        base: null
    }
];

const colonyBlackboard = new ColonyBlackboard();
const colonyScheduler = new ColonyScheduler(colonyMemory);
const characterRegistry = new CharacterRegistry(colonyMemory);
const colonyBrain = new ColonyBrain({
    scheduler: colonyScheduler,
    blackboard: colonyBlackboard,
    minimumPlanIntervalMs: BRAIN_INTERVAL_MS,
    allowedTools: STRATEGIC_TOOLS.map(tool => tool.name),
    normalizeToolCall: call => toolRegistry.validateToolCall(call, STRATEGIC_TOOLS),
    planWithLlm: context => askForColonyPlan({ ...context, tools: STRATEGIC_TOOLS })
});
const chatBusy = new Set();

async function main() {
    initializeCharacters();
    const bots = await Promise.all(AGENTS.map(createAgentBot));
    try {
        if (!CONFIGURED_CENTER) CENTER = centerOfBots(bots);
        AGENTS[0].base = CENTER.offset(-4, 0, 0);
        AGENTS[1].base = CENTER.offset(4, 0, 0);
        colonyTasks.bootstrap(CENTER, AGENTS);
        for (const agent of AGENTS) {
            colonyTasks.releaseAgentLeases(agent.name);
            colonyScheduler.disconnect(agent.id);
        }
        console.log(`[COLONY] survival MVP starting center=${CENTER.toString()} runtime=${RUNTIME_MS}ms`);
        if (SEED_RESOURCES) await prepareControlledWorld(bots[0].bot, bots[0].agent);
        await Promise.all(bots.map(({ bot, agent }) => initializeAgent(bot, agent)));
        publishAll(bots);
        await colonyBrain.plan({ force: true });
        await runColonyLoop(bots, Date.now() + RUNTIME_MS);
        printSummary();
    } finally {
        await sleep(1000);
        bots.forEach(({ bot }) => {
            try {
                bot.end();
            } catch {
                // Connection may already be closed.
            }
        });
    }
}

function createAgentBot(agent) {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({
            host: HOST,
            port: PORT,
            username: agent.name,
            version: VERSION
        });

        install26_2PacketFallbacks(bot);
        install26_2VelocityShim(bot);
        bot.loadPlugin(pathfinder);
        bot.once('spawn', async () => {
            try {
                movement.configure(bot);
                install26_2AttackShim(bot);
                await sleep(1500);
                console.log(`[COLONY] ${agent.name} spawned role=${agent.role}`);
                resolve({
                    bot,
                    agent,
                    lastError: null,
                    pendingSafetyCall: null,
                    behaviorTree: createColonyBodyTree()
                });
            } catch (error) {
                reject(error);
            }
        });
        bot.on('kicked', reason => console.log(`[COLONY] ${agent.name} kicked ${reason}`));
        bot.on('error', error => console.log(`[COLONY] ${agent.name} error ${error.message}`));
        bot.on('chat', (username, message) => handleColonyChat(bot, agent, username, message));
        bot.on('end', () => {
            colonyTasks.releaseAgentLeases(agent.name);
            colonyScheduler.disconnect(agent.id);
            colonyBlackboard.markOffline(agent.id);
        });
    });
}

async function initializeAgent(bot, agent) {
    if (SEED_RESOURCES) {
        await command(bot, `/gamemode survival ${agent.name}`, 500);
        await command(bot, `/tp ${agent.name} ${agent.base.x} ${agent.base.y} ${agent.base.z}`, 700);
        await seedAgent(bot, agent);
    }
    colonyMemory.setBotBase(agent.name, {
        role: agent.role,
        base: null,
        homeTarget: vectorToObject(agent.base),
        status: 'running',
        position: vectorToObject(bot.entity.position.floored())
    });
    bot.chat(`${agent.role} online. Shared storage ve request board hazir.`);
}

async function prepareControlledWorld(bot, agent) {
    await command(bot, `/gamemode creative ${agent.name}`, 500);
    await command(bot, `/tp ${agent.name} ${CENTER.x} ${CENTER.y + 12} ${CENTER.z}`, 1200);
    await setupTestArea(bot);
}

function initializeCharacters() {
    characterRegistry.ensureDefaults();
    const mico = characterRegistry.get('citizen_mico');
    characterRegistry.register({
        ...mico,
        username: AGENTS[0].name,
        profession: AGENTS[0].role
    });
    characterRegistry.register({
        id: 'citizen_mira',
        username: AGENTS[1].name,
        shortName: 'Mira',
        displayName: 'Mira',
        aliases: ['Mira', AGENTS[1].name],
        status: 'alive',
        profession: AGENTS[1].role,
        traits: {
            sociability: 0.56,
            courage: 0.72,
            curiosity: 0.68,
            discipline: 0.84,
            generosity: 0.64,
            ambition: 0.55
        },
        speech: { tone: 'calm and precise', verbosity: 'short' },
        values: ['reliability', 'safe progress'],
        preferences: { jobs: ['miner', 'quartermaster'], dislikedJobs: [] },
        relationships: {},
        reputation: { trust: 0.5, competence: 0.5, service: 0 }
    });
}

async function setupTestArea(bot) {
    await command(
        bot,
        `/fill ${CENTER.x - 10} ${CENTER.y - 15} ${CENTER.z - 10} ${CENTER.x + 10} ${CENTER.y - 1} ${CENTER.z + 10} cobblestone`,
        600
    );
    await command(
        bot,
        `/fill ${CENTER.x - 10} ${CENTER.y} ${CENTER.z - 10} ${CENTER.x + 10} ${CENTER.y + 7} ${CENTER.z + 10} air`,
        800
    );
    await buildFixtureTree(bot, CENTER.offset(-7, 0, 0));
    await buildFixtureTree(bot, CENTER.offset(7, 0, 4));
}

async function buildFixtureTree(bot, base) {
    await command(bot, `/fill ${base.x - 2} ${base.y + 3} ${base.z - 2} ${base.x + 2} ${base.y + 5} ${base.z + 2} oak_leaves[persistent=true]`, 300);
    await command(bot, `/fill ${base.x} ${base.y} ${base.z} ${base.x} ${base.y + 5} ${base.z} oak_log`, 300);
}

async function seedAgent(bot, agent) {
    await command(bot, `/clear ${agent.name}`, 250);
    if (agent.coordinator) {
        await command(bot, `/give ${agent.name} chest 1`, 250);
        await command(bot, `/give ${agent.name} cobblestone 32`, 250);
        await command(bot, `/give ${agent.name} oak_log 4`, 250);
        await command(bot, `/give ${agent.name} stone_axe 1`, 250);
        await command(bot, `/give ${agent.name} stone_pickaxe 1`, 250);
        await command(bot, `/give ${agent.name} stone_sword 1`, 250);
        await command(bot, `/give ${agent.name} bread 8`, 250);
    } else {
        await command(bot, `/give ${agent.name} cobblestone 48`, 250);
        await command(bot, `/give ${agent.name} oak_log 4`, 250);
        await command(bot, `/give ${agent.name} stone_pickaxe 1`, 250);
        await command(bot, `/give ${agent.name} stone_sword 1`, 250);
        await command(bot, `/give ${agent.name} torch 16`, 250);
        await command(bot, `/give ${agent.name} bread 8`, 250);
    }
}

function publishAll(entries) {
    for (const entry of entries) {
        if (!entry.bot.entity || entry.bot.health <= 0) continue;
        entry.observation = observe(entry.bot, entry.lastError);
        const active = colonyScheduler.list('assigned').find(order => order.assignedTo === entry.agent.id);
        colonyBlackboard.publish(entry.agent.id, entry.observation, {
            username: entry.agent.name,
            characterId: entry.agent.id,
            profession: entry.agent.role,
            status: entry.lastError ? 'recovering' : 'running',
            taskId: active?.id || null
        });
    }
}

async function enqueueBootstrapWork(entries) {
    for (const { bot, agent } of entries) {
        if (!bot.entity || bot.health <= 0) continue;
        const call = selectBootstrapTool(bot, agent);
        const prefix = `bootstrap:${agent.id}:`;
        const desiredId = call && call.tool !== 'wait_safe'
            ? `${prefix}${colonyTasks.taskLeaseKey(call)}`
            : null;
        for (const order of colonyScheduler.list()) {
            if (!order.id.startsWith(prefix) || order.id === desiredId) continue;
            if (['queued', 'assigned'].includes(order.status)) {
                colonyScheduler.cancel(order.id, 'bootstrap precondition already satisfied');
            }
        }
        if (!desiredId) continue;
        colonyScheduler.enqueue({
            id: desiredId,
            tool: call.tool,
            args: call.args || {},
            reason: call.reason,
            priority: 100,
            preferredAgent: agent.id,
            professions: [agent.role],
            maxAttempts: 5
        });
    }
}

function enqueueRoleFallback(bot, agent) {
    const call = colonyTasks.selectTask(bot, agent, { claim: false });
    if (!call || call.tool === 'wait_safe') return null;
    colonyScheduler.enqueue({
        id: `role:${agent.id}:${colonyTasks.taskLeaseKey(call)}`,
        tool: call.tool,
        args: call.args || {},
        reason: call.reason,
        priority: 40,
        preferredAgent: agent.id,
        professions: [agent.role],
        maxAttempts: 3
    });
    return colonyScheduler.dispatch(agentDescriptor(agent));
}

function enqueueRoleWork(entries) {
    for (const { bot, agent } of entries) {
        if (!bot.entity || bot.health <= 0) continue;
        const call = colonyTasks.selectTask(bot, agent, { claim: false });
        if (!call || call.tool === 'wait_safe') continue;
        colonyScheduler.enqueue({
            id: `role:${agent.id}:${colonyTasks.taskLeaseKey(call)}`,
            tool: call.tool,
            args: call.args || {},
            reason: call.reason,
            priority: call.tool === 'deposit_shared_storage' ? 98 : 40,
            preferredAgent: agent.id,
            professions: [agent.role],
            maxAttempts: 3
        });
    }
}

function agentDescriptor(agent) {
    return { id: agent.id, username: agent.name, profession: agent.role, status: 'running' };
}

function createSafetyWatchdog(entry, activeCall) {
    return setInterval(() => {
        const { bot } = entry;
        if (!bot.entity || bot.health <= 0 || entry.pendingSafetyCall) return;
        let emergency = null;
        if (survival.needsAir(bot)) {
            emergency = { action: 'escape_water', reason: 'Local oxygen watchdog' };
        } else {
            const threat = survival.nearestHostile(bot, 10);
            if (survival.shouldInterruptForThreat(bot, threat)) {
                emergency = survival.chooseThreatAction(bot, threat, bot.health);
            }
        }
        const call = toolRegistry.normalizeToolCall(emergency);
        if (!call || call.tool === activeCall.tool) return;
        entry.pendingSafetyCall = call;
        actionControl.cancel(bot, `local survival interrupt: ${call.tool}`);
        movement.stop(bot);
        try {
            bot.stopDigging();
        } catch {
            // Digging may not be active.
        }
    }, 250);
}

async function handleColonyChat(bot, agent, username, message) {
    if (AGENTS.some(candidate => candidate.name === username)) return;
    const character = characterRegistry.resolveAddress(message);
    if (!character || character.username !== bot.username || chatBusy.has(character.id)) return;
    chatBusy.add(character.id);
    try {
        const observation = observe(bot, null);
        const active = colonyScheduler.list('assigned').find(order => order.assignedTo === agent.id);
        const recent = colonyMemory.load().messages
            .filter(entry => entry.type === 'chat' && (entry.characterId === character.id || entry.player === username))
            .slice(-8);
        const reply = await askForChatReply({
            username,
            message,
            observation,
            level: { goal: active?.reason || 'support the colony safely' },
            profession: { id: agent.role },
            task: active ? { goal: active.reason } : null,
            playerMemory: character.relationships?.[`player:${username}`] || {},
            conversation: recent,
            episodes: colonyMemory.load().messages.slice(-6),
            character
        });
        bot.chat(String(reply).slice(0, 240));
        colonyMemory.addMessage({
            from: character.id,
            to: username,
            type: 'chat',
            characterId: character.id,
            player: username,
            message,
            reply
        });
    } catch (error) {
        console.log(`[COLONY_CHAT_ERROR] character=${character.id} ${error.message}`);
    } finally {
        chatBusy.delete(character.id);
    }
}

async function runColonyLoop(entries, deadline) {
    let tick = 0;
    while (Date.now() < deadline) {
        tick++;
        publishAll(entries);
        await enqueueBootstrapWork(entries);
        enqueueRoleWork(entries);
        await colonyBrain.plan();
        for (const entry of entries) {
            if (Date.now() >= deadline) break;
            await runAgentStep(entry, tick);
        }
        if (Date.now() >= deadline) break;
        if (isMvpComplete()) {
            console.log('[COLONY] MVP completion criteria reached.');
            return;
        }
        await sleep(LOOP_DELAY_MS);
    }
}

async function runAgentStep(entry, tick) {
    const { bot, agent } = entry;
    if (!bot.entity || bot.health <= 0) return;

    try {
        const observation = entry.observation || observe(bot, entry.lastError);
        const immediate = entry.pendingSafetyCall ||
            survival.chooseImmediateAction(bot, observation, { id: 'COLONY_SURVIVAL' });
        entry.pendingSafetyCall = null;
        let assignment = null;
        let workCall = null;
        if (!immediate) {
            assignment = colonyScheduler.dispatch(agentDescriptor(agent));
            if (!assignment) assignment = enqueueRoleFallback(bot, agent);
            workCall = assignment?.order
                ? { tool: assignment.order.tool, args: assignment.order.args, reason: assignment.order.reason }
                : null;
        }
        const decision = await entry.behaviorTree.tick({
            safetyCall: immediate ? toolRegistry.normalizeToolCall(immediate) : null,
            workCall
        });
        const toolCall = decision.value.toolCall;

        console.log(`[COLONY_LOOP] tick=${tick} bot=${agent.name} role=${agent.role} order=${assignment?.order.id || 'local_safety'} tool=${JSON.stringify(toolCall)} inv=${observation.inventoryText}`);
        const before = taskVerifier.capture(bot, observation);
        const heartbeat = assignment ? setInterval(() => {
            colonyScheduler.heartbeat(assignment.order.id, agent.id);
        }, Math.max(1000, Math.floor(Number(process.env.COLONY_LEASE_TTL_MS || 120000) / 3))) : null;
        const safetyWatchdog = assignment ? createSafetyWatchdog(entry, toolCall) : null;
        let executionResult;
        try {
            executionResult = await executeToolWithTimeout(bot, toolCall);
        } finally {
            if (heartbeat) clearInterval(heartbeat);
            if (safetyWatchdog) clearInterval(safetyWatchdog);
        }
        const afterObservation = observe(bot, null);
        if (assignment) {
            const verification = taskVerifier.verify(
                toolCall,
                before,
                taskVerifier.capture(bot, afterObservation),
                { bot, executionResult, beforeObservation: observation, afterObservation }
            );
            if (!verification.ok || verification.details?.fallback) {
                throw new taskVerifier.TaskVerificationError(verification.reason, verification.details);
            }
            colonyScheduler.complete(assignment.order.id, agent.id, verification);
            if (['ensure_base', 'build_shelter'].includes(toolCall.tool)) {
                const base = executionResult?.base || worldMemory.getBase();
                if (base) colonyMemory.setSharedBase(base);
            }
            colonyBlackboard.pushEvent('work_completed', {
                agentId: agent.id,
                orderId: assignment.order.id,
                evidence: verification
            });
        }
        entry.lastError = null;
        entry.activeOrderId = null;
        colonyMemory.setBotBase(agent.name, {
            role: agent.role,
            status: 'running',
            position: vectorToObject(bot.entity.position.floored()),
            inventory: observation.inventory
        });
    } catch (error) {
        colonyTasks.releaseAgentLeases(agent.name);
        const active = colonyScheduler.list('assigned').find(order => order.assignedTo === agent.id);
        if (active) colonyScheduler.fail(active.id, agent.id, error.message, true);
        entry.lastError = error.message;
        console.log(`[COLONY_STEP_ERROR] bot=${agent.name} ${error.message}`);
        movement.stop(bot);
        colonyMemory.setBotBase(agent.name, {
            role: agent.role,
            status: 'recovering',
            lastError: error.message
        });
        colonyBlackboard.pushEvent('work_failed', {
            agentId: agent.id,
            orderId: active?.id || null,
            error: error.message
        });
        await sleep(800);
    }
}

function selectBootstrapTool(bot, agent) {
    const inventory = colonyTasks.countInventory(bot);
    const sharedPosition = sharedStorage.getSharedStoragePosition();
    const chestNearby = sharedPosition && findBlockAtOrNear(bot, 'chest', sharedPosition, 3);
    if (chestNearby) return null;

    if (!agent.coordinator) {
        if ((inventory.cobblestone || 0) >= 16) {
            return {
                tool: 'wait_safe',
                args: { ms: 1500 },
                reason: 'farmer_miner: wait with first cobblestone until shared storage exists'
            };
        }
        return {
            tool: 'collect_stone',
            args: { count: 16 },
            reason: 'farmer_miner: gather first colony blocks while builder prepares storage'
        };
    }

    if ((inventory.chest || 0) > 0) {
        return {
            tool: 'ensure_shared_storage',
            args: vectorToObject(CENTER),
            reason: 'builder: place first shared storage chest'
        };
    }

    if (totalPlanks(inventory) >= 8) {
        return {
            tool: 'craft_item',
            args: { item: 'chest', count: 1 },
            reason: 'builder: craft shared storage chest'
        };
    }

    const logName = Object.keys(inventory).find(name => name.endsWith('_log') && inventory[name] > 0);
    if (logName) {
        return {
            tool: 'craft_item',
            args: { item: logName.replace(/_log$/, '_planks'), count: 8 },
            reason: 'builder: make planks for shared storage chest'
        };
    }

    return {
        tool: 'mine_block',
        args: { target: 'any_log' },
        reason: 'builder: collect wood for shared storage chest'
    };
}

function isMvpComplete() {
    const memory = colonyMemory.load();
    const shared = memory.sharedStorage?.inventory || {};
    const marker = memory.projects.find(project =>
        project.id === 'survival_marker' &&
        ['partial', 'complete'].includes(project.status)
    );
    return (shared.cobblestone || 0) >= 16 && Boolean(marker);
}

function observe(bot, lastError) {
    const colony = colonyMemory.load();
    const inventory = colonyTasks.countInventory(bot);
    const position = bot.entity.position;
    const nearbyMobs = Object.values(bot.entities || {})
        .filter(entity => entity !== bot.entity && entity.position && entity.position.distanceTo(position) <= 24)
        .map(entity => ({
            id: entity.id,
            name: entity.name || entity.displayName || 'unknown',
            distance: Number(entity.position.distanceTo(position).toFixed(1))
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 8);

    return {
        health: bot.health,
        food: bot.food,
        position: vectorToObject(position.floored()),
        inventory,
        inventoryText: inventoryText(inventory),
        nearbyBlocks: [],
        nearbyMobs,
        hasUsableChest: false,
        storageReady: true,
        base: colony.sharedBase || colony.bots[bot.username]?.base || null,
        survivalReady: true,
        lastError
    };
}

function findBlockAtOrNear(bot, name, position, radius) {
    const center = new Vec3(position.x, position.y, position.z);
    const direct = bot.blockAt(center);
    if (direct?.name === name) return direct;
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return null;
    return bot.findBlocks({ matching: id, maxDistance: radius, count: 16 })
        .map(blockPosition => bot.blockAt(blockPosition))
        .filter(Boolean)
        .filter(block => block.position.distanceTo(center) <= radius)[0] || null;
}

function totalPlanks(inventory) {
    return Object.entries(inventory)
        .filter(([name]) => name.endsWith('_planks'))
        .reduce((sum, [, count]) => sum + count, 0);
}

async function command(bot, text, waitMs = 350) {
    bot.chat(text);
    await sleep(waitMs);
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

function printSummary() {
    const memory = colonyMemory.load();
    console.log(`[COLONY_SUMMARY] shared=${JSON.stringify(memory.sharedStorage?.inventory || {})}`);
    console.log(`[COLONY_SUMMARY] requests=${JSON.stringify(memory.requests)}`);
    console.log(`[COLONY_SUMMARY] projects=${JSON.stringify(memory.projects)}`);
}

function inventoryText(inventory) {
    return Object.entries(inventory)
        .map(([name, count]) => `${name}:${count}`)
        .join(', ') || 'empty';
}

function vectorToObject(vector) {
    return { x: Math.floor(vector.x), y: Math.floor(vector.y), z: Math.floor(vector.z) };
}

function centerOfBots(entries) {
    const positions = entries.map(entry => entry.bot.entity.position);
    const total = positions.reduce((sum, position) => ({
        x: sum.x + position.x,
        y: sum.y + position.y,
        z: sum.z + position.z
    }), { x: 0, y: 0, z: 0 });
    return new Vec3(
        Math.floor(total.x / positions.length),
        Math.floor(total.y / positions.length),
        Math.floor(total.z / positions.length)
    );
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeToolWithTimeout(bot, call) {
    let timeout;
    const timedOut = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
            actionControl.cancel(bot, `colony task timeout: ${call?.tool || 'unknown'}`);
            movement.stop(bot);
            try {
                bot.stopDigging();
            } catch {
                // Digging may not be active.
            }
            reject(new Error(`Colony tool timed out after ${COLONY_TOOL_TIMEOUT_MS}ms: ${call?.tool || 'unknown'}`));
        }, COLONY_TOOL_TIMEOUT_MS);
    });
    try {
        return await Promise.race([toolRegistry.executeToolCall(bot, call), timedOut]);
    } finally {
        clearTimeout(timeout);
    }
}

main().catch(error => {
    console.log('[COLONY_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
