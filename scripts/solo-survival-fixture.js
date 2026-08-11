process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../protocol26Shim');

const { spawn } = require('node:child_process');
const mineflayer = require('mineflayer');

const HOST = process.env.MC_HOST || 'localhost';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const USERNAME = process.env.SOLO_FIXTURE_USERNAME || `Solo${String(Date.now()).slice(-8)}`;
const CENTER_X = Number(process.env.SOLO_FIXTURE_X || 3900);
const CENTER_Z = Number(process.env.SOLO_FIXTURE_Z || 3900);
const CENTER_Y = 70;
const TIMEOUT_MS = Number(process.env.SOLO_FIXTURE_TIMEOUT_MS || 2700000);
const STOP_LEVEL = 'L17_ESTABLISH_WHEAT_FARM';

let child = null;
let admin = null;
let gateReached = false;
let deathObserved = false;
let childOutput = '';

async function main() {
    if (USERNAME.length > 16) throw new Error('SOLO_FIXTURE_USERNAME must be at most 16 characters');
    admin = await createBot('Bot_Mico');
    await setupWorld(admin);
    admin.end();
    admin = null;

    child = startSoloBot();
    await waitForOutput('[BOOT]', 30000);

    admin = await createBot('Bot_Mico');
    await runCommands(admin, [
        `/gamemode survival ${USERNAME}`,
        `/tp ${USERNAME} ${CENTER_X} ${CENTER_Y} ${CENTER_Z}`,
        `/kill @e[type=minecraft:item,distance=..80]`,
        `/clear ${USERNAME}`
    ], 500);
    await sleep(700);
    const inventoryData = await queryCommand(
        admin,
        `/data get entity ${USERNAME} Inventory`,
        message => message.includes(`${USERNAME} has the following entity data`)
    );
    if (!inventoryData.trim().endsWith('[]')) {
        throw new Error(`Solo fixture did not start empty: ${inventoryData}`);
    }
    await runCommands(admin, ['/difficulty easy'], 400);
    admin.chat(`${USERNAME} auto start`);
    await sleep(900);
    admin.end();
    admin = null;

    const exitCode = await waitForChild(TIMEOUT_MS);
    if (deathObserved) throw new Error('Solo survival gate failed because the bot died');
    if (!gateReached) throw new Error(`Solo survival gate exited without reaching ${STOP_LEVEL} (code ${exitCode})`);
    console.log(`[SOLO_FIXTURE_RESULT] ok=true username=${USERNAME} gate=${STOP_LEVEL}`);
}

async function setupWorld(bot) {
    const commands = [
        '/gamemode creative Bot_Mico',
        '/clear Bot_Mico',
        `/tp Bot_Mico ${CENTER_X} 100 ${CENTER_Z}`,
        '/difficulty peaceful',
        ...flatTestTerrainCommands(CENTER_X, CENTER_Z, 80),
        `/fill ${CENTER_X + 3} 70 ${CENTER_Z + 3} ${CENTER_X + 6} 71 ${CENTER_Z + 6} stone`,
        `/kill @e[type=minecraft:cod,distance=..80]`,
        `/kill @e[type=minecraft:salmon,distance=..80]`,
        `/kill @e[type=minecraft:tropical_fish,distance=..80]`,
        `/kill @e[type=minecraft:pufferfish,distance=..80]`,
        `/kill @e[type=minecraft:item,distance=..80]`,
        treeCommands(CENTER_X + 10, CENTER_Z + 8, 'oak'),
        treeCommands(CENTER_X - 12, CENTER_Z + 8, 'birch'),
        treeCommands(CENTER_X + 12, CENTER_Z - 12, 'oak'),
        treeCommands(CENTER_X - 20, CENTER_Z - 16, 'oak'),
        treeCommands(CENTER_X - 18, CENTER_Z + 20, 'birch'),
        treeCommands(CENTER_X + 22, CENTER_Z + 20, 'oak'),
        `/fill ${CENTER_X + 22} 62 ${CENTER_Z + 22} ${CENTER_X + 25} 65 ${CENTER_Z + 25} iron_ore replace stone`,
        `/fill ${CENTER_X - 25} 62 ${CENTER_Z + 22} ${CENTER_X - 22} 65 ${CENTER_Z + 25} iron_ore replace stone`,
        `/fill ${CENTER_X + 22} 62 ${CENTER_Z - 25} ${CENTER_X + 25} 65 ${CENTER_Z - 22} iron_ore replace stone`,
        `/fill ${CENTER_X - 25} 62 ${CENTER_Z - 25} ${CENTER_X - 22} 65 ${CENTER_Z - 22} iron_ore replace stone`,
        `/fill ${CENTER_X - 7} 63 ${CENTER_Z - 7} ${CENTER_X - 4} 66 ${CENTER_Z - 4} coal_ore replace stone`,
        `/fill ${CENTER_X - 7} 69 ${CENTER_Z + 2} ${CENTER_X - 3} 69 ${CENTER_Z + 6} water`,
        '/time set minecraft:day',
        '/gamerule advance_time false'
    ].flat();

    await runCommands(bot, commands, 420);
    const animals = [];
    for (let index = 0; index < 12; index++) {
        animals.push(`/summon cow ${CENTER_X - 22 + index % 6} 70 ${CENTER_Z - 20 + Math.floor(index / 6) * 4}`);
    }
    for (let index = 0; index < 6; index++) {
        animals.push(`/summon sheep ${CENTER_X - 22 + index % 3} 70 ${CENTER_Z - 8 + Math.floor(index / 3) * 4} {Color:0b}`);
    }
    const ring = [
        [-28, -28], [0, -30], [28, -28], [30, 0],
        [28, 28], [0, 30], [-28, 28], [-30, 0]
    ];
    for (const [dx, dz] of ring) {
        animals.push(`/summon cow ${CENTER_X + dx} 70 ${CENTER_Z + dz}`);
        animals.push(`/summon sheep ${CENTER_X + dx + 2} 70 ${CENTER_Z + dz} {Color:0b}`);
    }
    await runCommands(bot, animals, 140);
    await sleep(600);
    await runCommands(bot, [`/kill @e[type=minecraft:item,distance=..80]`], 300);
}

function flatTestTerrainCommands(centerX, centerZ, radius) {
    const commands = [];
    const tileSize = 32;
    const minimumX = centerX - radius;
    const maximumX = centerX + radius - 1;
    const minimumZ = centerZ - radius;
    const maximumZ = centerZ + radius - 1;
    for (let x = minimumX; x <= maximumX; x += tileSize) {
        for (let z = minimumZ; z <= maximumZ; z += tileSize) {
            const x2 = Math.min(x + tileSize - 1, maximumX);
            const z2 = Math.min(z + tileSize - 1, maximumZ);
            commands.push(`/fill ${x} 50 ${z} ${x2} 68 ${z2} stone`);
            commands.push(`/fill ${x} 70 ${z} ${x2} 90 ${z2} air`);
        }
    }
    commands.push(`/fill ${minimumX} 69 ${minimumZ} ${maximumX} 69 ${maximumZ} grass_block`);
    return commands;
}

function treeCommands(x, z, wood) {
    return [
        `/fill ${x} 70 ${z} ${x} 75 ${z} ${wood}_log`,
        `/fill ${x - 2} 74 ${z - 2} ${x + 2} 77 ${z + 2} ${wood}_leaves replace air`
    ];
}

function startSoloBot() {
    const processHandle = spawn(process.execPath, ['bot.js'], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            MC_HOST: HOST,
            MC_PORT: String(PORT),
            MC_VERSION: VERSION,
            MC_USERNAME: USERNAME,
            AUTONOMOUS_ON_START: 'false',
            USE_LLM_PLANNER: 'false',
            LOOP_DELAY_MS: process.env.LOOP_DELAY_MS || '700',
            STOP_AT_LEVEL: STOP_LEVEL
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const forward = chunk => {
        const text = chunk.toString();
        childOutput = `${childOutput}${text}`.slice(-20000);
        process.stdout.write(text);
        if (text.includes('[GATE_REACHED]')) gateReached = true;
        if (text.includes('[DEATH]')) {
            deathObserved = true;
            if (child?.exitCode === null) child.kill('SIGTERM');
        }
    };
    processHandle.stdout.on('data', forward);
    processHandle.stderr.on('data', chunk => process.stderr.write(chunk));
    return processHandle;
}

function waitForOutput(marker, timeoutMs) {
    if (childOutput.includes(marker)) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${marker}`)), timeoutMs);
        const listener = chunk => {
            if (!chunk.toString().includes(marker)) return;
            clearTimeout(timer);
            child.stdout.removeListener('data', listener);
            resolve();
        };
        child.stdout.on('data', listener);
    });
}

function waitForChild(timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error(`Solo survival fixture timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.once('exit', code => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

function createBot(username) {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({ host: HOST, port: PORT, username, version: VERSION });
        install26_2PacketFallbacks(bot);
        install26_2VelocityShim(bot);
        bot.once('spawn', () => setTimeout(() => resolve(bot), 900));
        bot.once('error', reject);
    });
}

async function runCommands(bot, commands, delayMs) {
    for (const command of commands) {
        bot.chat(command);
        await sleep(delayMs);
    }
}

function queryCommand(bot, command, matches, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            bot.removeListener('messagestr', listener);
            reject(new Error(`Timed out waiting for command response: ${command}`));
        }, timeoutMs);
        const listener = message => {
            if (!matches(String(message))) return;
            clearTimeout(timer);
            bot.removeListener('messagestr', listener);
            resolve(String(message));
        };
        bot.on('messagestr', listener);
        bot.chat(command);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function cleanup() {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (admin) admin.end();
    try {
        const cleanupBot = await createBot('Bot_Mico');
        cleanupBot.chat('/gamerule advance_time true');
        await sleep(500);
        cleanupBot.end();
    } catch {
        // Paper may already be stopping; cleanup must not hide the test result.
    }
}

main()
    .catch(error => {
        console.error('[SOLO_FIXTURE_FATAL]', error.stack || error.message);
        process.exitCode = 1;
    })
    .finally(cleanup);
