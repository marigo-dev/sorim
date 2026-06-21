const assert = require('assert');
const { Vec3 } = require('vec3');
const CombatSurvival = require('../src/combat-survival');

function createLayer(items = [], memory = { data: {} }, options = {}) {
    const bot = {
        inventory: {
            items: () => items,
            slots: []
        },
        entity: {
            position: new Vec3(0, 64, 0)
        },
        entities: options.entities || {},
        canSeeEntity: options.canSeeEntity || (() => true)
    };
    return new CombatSurvival({ bot, memory });
}

function observation(overrides = {}) {
    return {
        health: 20,
        food: 20,
        isNight: false,
        position: { x: 0, y: 64, z: 0 },
        inventory: { items: {}, emptySlots: 20, text: 'Bos' },
        hostileMobs: [],
        ...overrides
    };
}

assert.deepStrictEqual(
    createLayer([{ name: 'stone_sword', count: 1 }]).chooseAction(observation({
        hostileMobs: [{ id: 1, name: 'zombie', distance: 3 }]
    })),
    {
        type: 'fight',
        targetId: 1,
        threat: 'zombie',
        reason: 'zombie yakin tehdit'
    }
);

assert.strictEqual(
    createLayer([{ name: 'stone_sword', count: 1 }]).chooseAction(observation({
        health: 19,
        food: 9,
        hostileMobs: [{ id: 11, name: 'spider', distance: 15 }]
    })),
    null
);

assert.deepStrictEqual(
    createLayer([]).chooseAction(observation({
        hostileMobs: [{ id: 2, name: 'slime', distance: 3 }]
    })),
    {
        type: 'flee',
        targetId: 2,
        threat: 'slime',
        distance: 3,
        reason: 'slime ile yakin savas riskli'
    }
);

assert.strictEqual(
    createLayer([{ name: 'stone_sword', count: 1 }]).chooseAction(observation({
        health: 13,
        hostileMobs: [{ id: 21, name: 'creeper', distance: 17.5 }]
    })),
    null
);

assert.deepStrictEqual(
    createLayer([]).chooseAction(observation({
        hostileMobs: [{ id: 22, name: 'zombie_villager', distance: 3 }]
    })),
    {
        type: 'flee',
        targetId: 22,
        threat: 'zombie_villager',
        distance: 3,
        reason: 'zombie_villager ile yakin savas riskli'
    }
);

assert.deepStrictEqual(
    createLayer([{ name: 'stone_sword', count: 1 }]).chooseAction(observation({
        hostileMobs: [{ id: 3, name: 'creeper', distance: 8 }]
    })),
    {
        type: 'flee',
        targetId: 3,
        threat: 'creeper',
        distance: 8,
        reason: 'creeper ile yakin savas riskli'
    }
);

assert.deepStrictEqual(
    createLayer([{ name: 'stone_sword', count: 1 }]).chooseAction(observation({
        health: 12,
        hostileMobs: [{ id: 33, name: 'skeleton', distance: 6 }]
    })),
    {
        type: 'fight',
        targetId: 33,
        threat: 'skeleton',
        reason: 'skeleton cok yakin; kacmak yerine baski kur'
    }
);

assert.deepStrictEqual(
    createLayer(
        [{ name: 'stone_sword', count: 1 }],
        { data: { shelter: { x: 8, y: 64, z: 0 } } }
    ).chooseAction(observation({
        health: 6,
        inventory: { items: { cobblestone: 8 }, emptySlots: 20, text: 'cobblestone:8' },
        hostileMobs: [{ id: 34, name: 'skeleton', distance: 8 }]
    })),
    {
        type: 'barricade_shelter',
        targetId: 34,
        threat: 'skeleton',
        reason: 'Can kritik (6/20); base yakininda savunmaya kapan'
    }
);

assert.deepStrictEqual(
    createLayer(
        [],
        {
            data: {
                shelter: { x: 0, y: 64, z: 0 },
                shelterBarricaded: true
            }
        }
    ).chooseAction(observation({
        health: 12,
        inventory: { items: { oak_planks: 1 }, emptySlots: 20, text: 'oak_planks:1' },
        hostileMobs: [{ id: 35, name: 'skeleton', distance: 3 }]
    })),
    {
        type: 'barricade_shelter',
        targetId: 35,
        threat: 'skeleton',
        reason: 'Can kritik (12/20); base yakininda savunmaya kapan'
    }
);

assert.deepStrictEqual(
    createLayer(
        [],
        { data: { shelter: { x: 0, y: 64, z: 0 } } }
    ).chooseAction(observation({
        health: 1,
        hostileMobs: [{ id: 36, name: 'skeleton', distance: 1 }]
    })),
    {
        type: 'fight',
        targetId: 36,
        threat: 'skeleton',
        standGround: true,
        allowUnarmed: true,
        reason: 'skeleton cok yakin; kacmak yerine baski kur'
    }
);

const pitLayer = createLayer(
    [{ name: 'stone_sword', count: 1 }],
    { data: { base: { x: 0, y: 64, z: 0 } } }
);
assert.deepStrictEqual(
    pitLayer.chooseAction(observation({
        position: { x: 0, y: 58, z: 0 },
        hostileMobs: [{ id: 4, name: 'zombie', distance: 3 }]
    })),
    {
        type: 'escape_pit',
        targetId: 4,
        threat: 'zombie',
        reason: 'zombie tehdidi var ama bot cukurda; once yukari cik'
    }
);

const recoveryLayer = createLayer([]);
recoveryLayer.escapeUntil = Date.now() + 1000;
assert.deepStrictEqual(
    recoveryLayer.chooseAction(observation({ health: 12 })),
    {
        type: 'flee',
        targetId: null,
        threat: 'bilinmeyen_saldirgan',
        reason: 'Hasar sonrasi guvenli mesafe olustur'
    }
);

const shelterFightLayer = createLayer(
    [{ name: 'stone_sword', count: 1 }],
    { data: { shelter: { x: 0, y: 64, z: 0 } } }
);
shelterFightLayer.reportDamage({ id: 42 });
assert.deepStrictEqual(
    shelterFightLayer.chooseAction(observation({
        health: 10,
        isNight: true,
        hostileMobs: [{ id: 42, name: 'spider', distance: 5 }]
    })),
    {
        type: 'fight',
        targetId: 42,
        threat: 'spider',
        standGround: true,
        reason: 'spider barinaga vurdu; iceride karsilik ver'
    }
);

const corneredFightLayer = createLayer(
    [{ name: 'stone_sword', count: 1 }],
    { data: { shelter: { x: 0, y: 64, z: 0 } } }
);
assert.deepStrictEqual(
    corneredFightLayer.chooseAction(observation({
        health: 6,
        isNight: true,
        hostileMobs: [{ id: 43, name: 'spider', distance: 2 }]
    })),
    {
        type: 'fight',
        targetId: 43,
        threat: 'spider',
        standGround: true,
        reason: 'spider cok yakin; barinak icinde kacmak yerine savas'
    }
);

assert.deepStrictEqual(
    corneredFightLayer.chooseAction(observation({
        health: 2,
        isNight: true,
        hostileMobs: [{ id: 44, name: 'spider', distance: 2 }]
    })),
    {
        type: 'fight',
        targetId: 44,
        threat: 'spider',
        standGround: true,
        reason: 'spider cok yakin; barinak icinde kacmak yerine savas'
    }
);

const lastChanceLayer = createLayer([{ name: 'stone_axe', count: 1 }]);
lastChanceLayer.reportDamage({ id: 46 });
assert.deepStrictEqual(
    lastChanceLayer.chooseAction(observation({
        health: 8,
        hostileMobs: [{ id: 46, name: 'spider', distance: 2 }]
    })),
    {
        type: 'fight',
        targetId: 46,
        threat: 'spider',
        standGround: true,
        reason: 'spider cok yakin; kacarken hasar aliyor, karsilik ver'
    }
);

const hiddenThreatAction = createLayer(
    [{ name: 'stone_sword', count: 1 }],
    { data: { shelter: { x: 0, y: 64, z: 0 } } },
    {
        entities: { 45: { id: 45, isValid: true } },
        canSeeEntity: () => false
    }
).chooseAction(observation({
        health: 2,
        isNight: true,
        hostileMobs: [{ id: 45, name: 'spider', distance: 2 }]
    }));
assert.strictEqual(hiddenThreatAction.type, 'idle');
assert.strictEqual(
    hiddenThreatAction.reason,
    'Can cok dusuk (2/20); tehdit yokken iyiles'
);
assert.ok(hiddenThreatAction.until > Date.now());

assert.strictEqual(
    createLayer([]).chooseAction(observation({
        health: 9,
        isNight: true
    })).type,
    'idle'
);

const shelterLayer = createLayer([], { data: {} });
assert.deepStrictEqual(
    shelterLayer.chooseAction(observation({
        isNight: true,
        health: 18,
        inventory: { items: { dirt: 4 }, emptySlots: 20, text: 'dirt:4' },
        hostileMobs: [{ id: 5, name: 'zombie', distance: 12 }]
    })),
    {
        type: 'flee',
        targetId: 5,
        threat: 'zombie',
        distance: 12,
        reason: 'zombie ile yakin savas riskli'
    }
);

assert.strictEqual(
    createLayer([{ name: 'stone_sword', count: 1 }], { data: {} })
        .chooseAction(observation({
            isNight: true,
            health: 10,
            inventory: { items: { dirt: 20 }, emptySlots: 20, text: 'dirt:20' },
            hostileMobs: [{ id: 6, name: 'zombie', distance: 15 }]
        })).type,
    'emergency_shelter'
);

console.log('Combat survival tests passed.');
