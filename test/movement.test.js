const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const movement = require('../src/skills/movement');

async function main() {
    assert.deepEqual(
        Array.from({ length: 8 }, (_, index) => movement.squareSpiralCell(index)),
        [
            { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }, { x: -1, z: 1 },
            { x: -1, z: 0 }, { x: -1, z: -1 }, { x: 0, z: -1 }, { x: 1, z: -1 }
        ],
        'exploration must cover the first ring without duplicate cells'
    );
    const frontierBot = { entity: { position: new Vec3(0, 64, 0) } };
    const firstFrontier = movement.selectExplorationWaypoint(frontierBot, 'test_frontier');
    assert.deepEqual(firstFrontier, new Vec3(24, 64, 0));
    assert.deepEqual(
        movement.selectExplorationWaypoint(frontierBot, 'test_frontier'),
        firstFrontier,
        'a partially reached frontier must remain active across planning ticks'
    );
    movement.noteExplorationProgress(frontierBot, 'test_frontier', false);
    movement.noteExplorationProgress(frontierBot, 'test_frontier', false);
    assert.deepEqual(
        movement.selectExplorationWaypoint(frontierBot, 'test_frontier'),
        new Vec3(24, 64, 24),
        'two stalled attempts must advance to the next unvisited spiral cell'
    );
    const detourBot = {
        entity: { position: new Vec3(0, 64, 0) },
        blockAt(position) {
            if (position.y === 63) return { name: 'stone', boundingBox: 'block' };
            if (position.x === -1 && position.z === 0 && position.y === 64) {
                return { name: 'stone', boundingBox: 'block' };
            }
            return { name: 'air', boundingBox: 'empty' };
        }
    };
    const detours = movement.localDetourCandidates(
        detourBot,
        new Vec3(-8, 64, 0),
        new Vec3(-1, 64, 0)
    );
    assert.equal(detours.some(position => position.equals(new Vec3(-1, 64, 0))), false);
    assert.equal(
        detours.some(position => Math.abs(position.z) === 1),
        true,
        'a blocked forward step must expose a lateral walkable detour'
    );
    const slopeBot = {
        entity: { position: new Vec3(0, 64, 0) },
        blockAt(position) {
            if (position.y === 63) return { name: 'stone', boundingBox: 'block' };
            if (position.y >= 64 && position.x < 1) {
                return { name: 'dirt', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
            }
            return { name: 'air', boundingBox: 'empty' };
        }
    };
    const slopeEscapes = movement.localEscapeCandidates(slopeBot);
    assert.ok(slopeEscapes.length > 0, 'a steep face must expose an open escape cell');
    assert.ok(
        slopeEscapes.every(position => position.x >= 1),
        'dead-end recovery must choose the open side instead of pressing into the slope'
    );
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

    let guardedStop = false;
    const guardedBot = {
        entity: { position: new Vec3(0, 64, 0) },
        pathfinder: {
            goto: () => new Promise(() => {}),
            setGoal: goal => {
                if (goal === null) guardedStop = true;
            }
        },
        clearControlStates() {}
    };
    setTimeout(() => {
        guardedBot.entity.position.y = 63;
    }, 150);
    const guardedAt = Date.now();
    const guarded = await movement.explore(guardedBot, {
        target: 'wood',
        stopWhen: () => null,
        abortWhen: () => guardedBot.entity.position.y < 64
            ? 'Protected mine opening entered'
            : false
    });
    assert.equal(guarded.guarded, true);
    assert.match(guarded.error.message, /Protected mine opening/);
    assert.equal(guardedStop, true);
    assert.ok(Date.now() - guardedAt < 1500, 'protected-area guard must interrupt navigation promptly');

    const embedded = {
        entity: {
            position: new Vec3(0, 64, 0),
            onGround: false,
            velocity: new Vec3(0, -0.1, 0)
        },
        blockAt: position => {
            if (position.y === 64) return { name: 'grass_block', position, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
            if (position.y === 63) return { name: 'stone', position, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
            return { name: 'air', boundingBox: 'empty' };
        }
    };
    assert.equal(movement.resyncCollision(embedded), true);
    assert.equal(embedded.entity.position.y, 64, 'collision recovery must not teleport the client body');
    assert.equal(embedded.entity.onGround, false);

    const headEmbedded = {
        entity: {
            position: new Vec3(0, 64, 0),
            onGround: false,
            velocity: new Vec3(0, 0, 0)
        },
        blockAt: position => {
            if (position.y === 65) return { name: 'grass_block', position, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
            return { name: 'air', boundingBox: 'empty' };
        }
    };
    assert.equal(movement.resyncCollision(headEmbedded), true);
    assert.equal(headEmbedded.entity.position.y, 64, 'head collision must release controls without fake vertical movement');

    const blockAtStep = position => {
        const key = `${position.x},${position.y},${position.z}`;
        if (key === '1,64,0') {
            return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
        }
        if (position.y === 63) return { name: 'stone', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
    };
    const obstacleBot = {
        entity: { position: new Vec3(0, 64, 0), yaw: -Math.PI / 2 },
        blockAt: blockAtStep
    };
    assert.equal(movement.frontObstacle(obstacleBot, new Vec3(4, 64, 0)), 'step');

    const diagonalBot = {
        entity: { position: new Vec3(0, 64, 0), yaw: -Math.PI * 0.75 },
        blockAt: position => {
            if (position.x === 1 && position.y === 64 && position.z === 1) {
                return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
            }
            if (position.y === 63) return { name: 'stone', boundingBox: 'block' };
            return { name: 'air', boundingBox: 'empty' };
        }
    };
    assert.equal(
        movement.frontObstacle(diagonalBot, new Vec3(4, 64, 4)),
        'step',
        'diagonal body contact must detect a climbable block'
    );

    const wallBot = {
        ...obstacleBot,
        blockAt: position => {
            if (position.x === 1 && [64, 65].includes(position.y)) {
                return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
            }
            return blockAtStep(position);
        }
    };
    assert.equal(movement.frontObstacle(wallBot, new Vec3(4, 64, 0)), 'wall');

    let clearedSuccessfulGoal = false;
    const successfulBot = {
        entity: { position: new Vec3(0, 64, 0), yaw: 0, onGround: true, velocity: new Vec3(0, 0, 0) },
        controlState: {},
        blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
        pathfinder: {
            goto: async () => {
                successfulBot.entity.position = new Vec3(3, 64, 0);
            },
            setGoal: goal => { if (goal === null) clearedSuccessfulGoal = true; }
        },
        clearControlStates() {}
    };
    await movement.moveNear(successfulBot, new Vec3(3, 64, 0), 1, 1000);
    assert.equal(clearedSuccessfulGoal, true, 'a completed path must release the pathfinder goal');

    let cancelledGoal = false;
    let clearedControls = false;
    const noPathBot = {
        entity: { position: new Vec3(0, 64, 0), yaw: -Math.PI / 2 },
        blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
        pathfinder: {
            goto: async () => { throw new Error('No path to the goal!'); },
            setGoal: goal => { if (goal === null) cancelledGoal = true; }
        },
        clearControlStates: () => { clearedControls = true; }
    };
    await assert.rejects(
        movement.moveNear(noPathBot, new Vec3(4, 64, 0), 1, 100),
        /No path/
    );
    assert.equal(cancelledGoal, true, 'failed navigation must cancel its old pathfinder goal');
    assert.equal(clearedControls, true, 'failed navigation must release movement controls');
    console.log('Movement exploration target interruption passed.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
