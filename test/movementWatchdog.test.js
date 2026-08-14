const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { MovementWatchdog, StallDetector } = require('../src/diagnostics/movementWatchdog');

const detector = new StallDetector({ stallMs: 1000, progressDistance: 0.2, cooldownMs: 5000 });
assert.equal(detector.update({ at: 0, commanded: true, position: { x: 0, z: 0 } }), null);
assert.equal(detector.update({ at: 900, commanded: true, position: { x: 0.05, z: 0 } }), null);
assert.deepEqual(detector.update({ at: 1100, commanded: true, position: { x: 0.05, z: 0 } }), {
    stationaryMs: 1100,
    displacement: 0.05
});

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'sorim-movement-watchdog-'));
const bot = new EventEmitter();
bot.username = 'marigo';
bot.entity = {
    position: new Vec3(10.5, 64, -3.5),
    velocity: new Vec3(0, 0, 0),
    yaw: 0,
    pitch: 0,
    onGround: true
};
bot.controlState = { forward: true };
bot.sorimMovementIntent = { kind: 'pathfinder', target: { x: 14, y: 64, z: -3 }, at: Date.now() };
bot.pathfinder = { goal: { x: 14, y: 64, z: -3, range: 1 } };
bot.blockAt = position => position.y === 63
    ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
    : { name: 'air', boundingBox: 'empty', shapes: [] };

const watchdog = new MovementWatchdog(bot, {
    output,
    stallMs: 1000,
    cooldownMs: 5000,
    sampleMs: 1,
    radius: 1
});
watchdog.tick(100);
const incident = watchdog.tick(1200);
assert.ok(incident);
assert.equal(incident.intent.kind, 'pathfinder');
assert.equal(incident.blocks.length, 9);
assert.equal(fs.existsSync(path.join(output, 'latest.json')), true);

fs.rmSync(output, { recursive: true, force: true });
console.log('Movement watchdog incident capture passed.');
