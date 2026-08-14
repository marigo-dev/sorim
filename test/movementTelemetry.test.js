const assert = require('node:assert/strict');
const { analyzeScenario, motionStats } = require('../src/diagnostics/movementTelemetry');

const moving = [
    { at: 0, position: { x: 0, y: 64, z: 0 } },
    { at: 500, position: { x: 1, y: 64, z: 0 } },
    { at: 1000, position: { x: 2, y: 64, z: 0 } }
];
assert.deepEqual(motionStats(moving), {
    displacement: 2,
    distance: 2,
    peakSpeed: 2,
    durationMs: 1000
});

const scenario = analyzeScenario({
    name: 'test',
    startedAt: 0,
    samples: moving.map(sample => ({
        at: sample.at,
        self: sample.position,
        observed: { ...sample.position, x: sample.position.x + 0.05 },
        velocity: { x: 0, y: 0, z: 0 },
        onGround: true,
        controls: ['forward']
    }))
}, { minimumDisplacement: 1.5 });

assert.equal(scenario.passed, true);
assert.equal(scenario.observed.displacement, 2);
assert.equal(scenario.maximumDivergence, 0.05);

const stuck = analyzeScenario({
    name: 'stuck',
    startedAt: 0,
    samples: [0, 500, 1000, 1500].map(at => ({
        at,
        self: { x: 0, y: 64, z: 0 },
        observed: { x: 0, y: 64, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        onGround: true,
        controls: ['forward']
    }))
}, { minimumDisplacement: 1 });

assert.equal(stuck.passed, false);
assert.ok(stuck.commandedStationaryMs >= 1500);
assert.ok(stuck.failures.some(failure => failure.includes('stationary')));

console.log('Independent movement telemetry analysis passed.');
