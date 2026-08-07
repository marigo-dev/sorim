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

    const sensedTree = { name: 'birch_log', position: new Vec3(8, 64, 0) };
    let sensorStopped = false;
    const sensingBot = {
        entity: { position: new Vec3(0, 64, 0) },
        findBlock: options => options.matching(sensedTree) ? sensedTree : null,
        pathfinder: {
            goto: () => new Promise(() => {}),
            setGoal: goal => {
                if (goal === null) sensorStopped = true;
            }
        },
        clearControlStates() {}
    };
    const sensed = await movement.explore(sensingBot, { target: 'wood' });
    assert.equal(sensed.found, sensedTree);
    assert.equal(sensorStopped, true);

    const embedded = {
        entity: {
            position: new Vec3(0, 64, 0),
            onGround: false,
            velocity: new Vec3(0, -0.1, 0)
        },
        blockAt: position => {
            if (position.y === 64) return { name: 'grass_block', boundingBox: 'block' };
            if (position.y === 63) return { name: 'stone', boundingBox: 'block' };
            return { name: 'air', boundingBox: 'empty' };
        }
    };
    assert.equal(movement.resyncCollision(embedded), true);
    assert.equal(embedded.entity.position.y, 65);
    assert.equal(embedded.entity.onGround, true);

    const headEmbedded = {
        entity: {
            position: new Vec3(0, 64, 0),
            onGround: false,
            velocity: new Vec3(0, 0, 0)
        },
        blockAt: position => {
            if (position.y === 65) return { name: 'grass_block', boundingBox: 'block' };
            return { name: 'air', boundingBox: 'empty' };
        }
    };
    assert.equal(movement.resyncCollision(headEmbedded), true);
    assert.equal(headEmbedded.entity.position.y, 66);
    console.log('Movement exploration target interruption passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
