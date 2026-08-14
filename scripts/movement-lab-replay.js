process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../src/logger').installConsoleFilter();
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../src/protocol26Shim');

const fs = require('node:fs');
const path = require('node:path');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const movement = require('../src/skills/movement');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const USERNAME = process.env.MOVEMENT_LAB_USERNAME || 'Bot_Mico';
const INCIDENT = process.argv[2] || process.env.MOVEMENT_INCIDENT ||
    path.join(__dirname, '..', 'artifacts', 'movement-incidents', 'latest.json');
const LAB_ORIGIN = new Vec3(4000, 80, 4000);

async function main() {
    const incident = JSON.parse(fs.readFileSync(INCIDENT, 'utf8'));
    validateIncident(incident);
    const bot = await createBot();
    try {
        movement.configure(bot);
        await recreate(bot, incident);
        const start = bot.entity.position.clone();
        const target = translatedTarget(incident);
        console.log(`[LAB] replay=${incident.id} start=${start.toString()} target=${target.toString()}`);
        let error = null;
        try {
            await movement.moveNear(bot, target, 1.25, 20000);
        } catch (caught) {
            error = caught;
        }
        const distance = bot.entity.position.distanceTo(target);
        const result = {
            incident: incident.id,
            passed: !error && distance <= 1.5,
            start: point(start),
            final: point(bot.entity.position),
            target: point(target),
            distance: Number(distance.toFixed(3)),
            error: error?.message || null
        };
        console.log(`[LAB_RESULT] ${JSON.stringify(result)}`);
        if (!result.passed) process.exitCode = 1;
    } finally {
        movement.stop(bot);
        bot.end();
    }
}

async function recreate(bot, incident) {
    await command(bot, `/gamemode creative ${USERNAME}`, 150);
    await command(bot, `/tp ${USERNAME} ${LAB_ORIGIN.x + 0.5} ${LAB_ORIGIN.y + 5} ${LAB_ORIGIN.z + 0.5}`, 900);
    await command(bot, `/fill ${LAB_ORIGIN.x - 5} ${LAB_ORIGIN.y - 3} ${LAB_ORIGIN.z - 5} ` +
        `${LAB_ORIGIN.x + 5} ${LAB_ORIGIN.y + 4} ${LAB_ORIGIN.z + 5} air`, 250);
    const blocks = [...incident.blocks]
        .filter(block => /^[a-z0-9_]+$/.test(block.name))
        .sort((left, right) => left.offset.y - right.offset.y);
    for (const block of blocks) {
        const target = LAB_ORIGIN.offset(block.offset.x, block.offset.y, block.offset.z);
        await command(bot, `/setblock ${target.x} ${target.y} ${target.z} minecraft:${block.name}`, 35);
    }
    const fractional = {
        x: incident.position.x - incident.origin.x,
        y: incident.position.y - incident.origin.y,
        z: incident.position.z - incident.origin.z
    };
    await command(bot, `/tp ${USERNAME} ${LAB_ORIGIN.x + fractional.x} ` +
        `${LAB_ORIGIN.y + fractional.y} ${LAB_ORIGIN.z + fractional.z} ${yawDegrees(incident.yaw)} 0`, 500);
    await command(bot, `/effect give ${USERNAME} resistance 3 255 true`, 100);
    await command(bot, `/gamemode survival ${USERNAME}`, 300);
    movement.stop(bot);
}

function translatedTarget(incident) {
    const target = incident.intent?.target || incident.pathfinderGoal;
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.z)) {
        return LAB_ORIGIN.offset(4, 0, 0);
    }
    return new Vec3(
        LAB_ORIGIN.x + target.x - incident.origin.x,
        LAB_ORIGIN.y + (Number.isFinite(target.y) ? target.y - incident.origin.y : 0),
        LAB_ORIGIN.z + target.z - incident.origin.z
    );
}

function validateIncident(incident) {
    if (incident?.schemaVersion !== 1 || !incident.position || !incident.origin || !Array.isArray(incident.blocks)) {
        throw new Error('Unsupported or incomplete movement incident');
    }
}

function createBot() {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION });
        install26_2PacketFallbacks(bot);
        install26_2VelocityShim(bot);
        bot.loadPlugin(pathfinder);
        bot.once('spawn', () => setTimeout(() => resolve(bot), 1000));
        bot.once('error', reject);
    });
}

async function command(bot, text, waitMs) {
    bot.chat(text);
    await movement.sleep(waitMs);
}

function yawDegrees(yaw) {
    return Number((-Number(yaw || 0) * 180 / Math.PI).toFixed(2));
}

function point(value) {
    return { x: Number(value.x.toFixed(3)), y: Number(value.y.toFixed(3)), z: Number(value.z.toFixed(3)) };
}

main().catch(error => {
    console.error('[MOVEMENT_LAB_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
