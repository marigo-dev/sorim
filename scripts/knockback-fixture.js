process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../logger').installConsoleFilter();
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../protocol26Shim');

const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const entityActions = require('../skills/entityActions');
const movement = require('../skills/movement');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const CENTER = new Vec3(3700, 70, 3200);

async function main() {
    const target = await createBot('KnockbackDummy');
    const attacker = await createBot('Bot_Mico');
    try {
        await command(attacker, `/gamemode creative ${attacker.username}`, 250);
        await command(attacker, `/fill ${CENTER.x - 8} ${CENTER.y} ${CENTER.z - 8} ${CENTER.x + 8} ${CENTER.y + 5} ${CENTER.z + 8} air`, 350);
        await command(attacker, `/fill ${CENTER.x - 8} ${CENTER.y - 1} ${CENTER.z - 8} ${CENTER.x + 8} ${CENTER.y - 1} ${CENTER.z + 8} stone`, 350);
        await command(attacker, `/gamemode survival ${target.username}`, 250);
        await command(attacker, `/gamemode survival ${attacker.username}`, 250);
        await command(attacker, `/tp ${target.username} ${CENTER.x} ${CENTER.y} ${CENTER.z}`, 500);
        await command(attacker, `/tp ${attacker.username} ${CENTER.x - 2} ${CENTER.y} ${CENTER.z}`, 800);
        await movement.sleep(3000);

        const targetEntity = await waitForEntity(attacker, target.username, 5000);
        const origin = target.entity.position.clone();
        const healthBefore = target.health;
        let strongestVelocity = { x: 0, y: 0, z: 0 };
        target.on('sorimVelocity', event => {
            const current = Math.hypot(event.velocity.x, event.velocity.z);
            const strongest = Math.hypot(strongestVelocity.x, strongestVelocity.z);
            if (current > strongest) strongestVelocity = event.velocity;
        });

        for (let attempt = 0; attempt < 3 && target.health >= healthBefore; attempt++) {
            const liveTarget = attacker.players[target.username]?.entity;
            if (!liveTarget) throw new Error('Target entity disappeared before attack');
            await attacker.lookAt(liveTarget.position.offset(0, 1.1, 0), true);
            entityActions.attack(attacker, liveTarget);
            await movement.sleep(1300);
        }

        const selfDisplacement = Math.hypot(
            target.entity.position.x - origin.x,
            target.entity.position.z - origin.z
        );
        const observed = attacker.players[target.username]?.entity?.position;
        const observedDisplacement = observed
            ? Math.hypot(observed.x - origin.x, observed.z - origin.z)
            : 0;
        const horizontalVelocity = Math.hypot(strongestVelocity.x, strongestVelocity.z);
        const result = {
            healthBefore,
            healthAfter: target.health,
            strongestVelocity,
            horizontalVelocity: Number(horizontalVelocity.toFixed(3)),
            selfDisplacement: Number(selfDisplacement.toFixed(3)),
            observedDisplacement: Number(observedDisplacement.toFixed(3)),
            finalPosition: target.entity.position.toString()
        };
        console.log(`[KNOCKBACK_RESULT] ${JSON.stringify(result)}`);

        if (target.health >= healthBefore) throw new Error('Attack did not reduce target health');
        if (horizontalVelocity < 0.1) throw new Error('No meaningful 26.2 knockback velocity was restored');
        if (selfDisplacement < 0.25 || observedDisplacement < 0.2) {
            throw new Error('Knockback did not produce verified world displacement');
        }
    } finally {
        target.end();
        attacker.end();
        await movement.sleep(500);
    }
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

function waitForEntity(bot, username, timeoutMs) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const check = () => {
            const entity = bot.players[username]?.entity;
            if (entity) return resolve(entity);
            if (Date.now() >= deadline) return reject(new Error(`Could not see ${username}`));
            setTimeout(check, 100);
        };
        check();
    });
}

async function command(bot, text, waitMs) {
    bot.chat(text);
    await movement.sleep(waitMs);
}

main().catch(error => {
    console.error('[KNOCKBACK_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
