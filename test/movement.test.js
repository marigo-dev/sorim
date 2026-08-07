const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const movement = require('../skills/movement');

async function main() {
    const marker = { name: 'oak_log', position: new Vec3(12, 64, 4) };
    let scans = 0;
    let stopped = false;
    const bot = {
        entity: { position: new Vec3(0, 64, 0) },
        pathfinder: {
            goto: () => new Promise(() => {}),
            setGoal: goal => {
                if (goal === null) stopped = true;
            }
        },
        clearControlStates() {}
    };

    const startedAt = Date.now();
    const result = await movement.explore(bot, {
        target: 'wood',
        stopWhen: () => ++scans >= 2 ? marker : null
    });

    assert.equal(result.found, marker);
    assert.equal(result.reached, false);
    assert.equal(stopped, true);
    assert.ok(Date.now() - startedAt < 2000);
    console.log('Movement exploration target interruption passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
