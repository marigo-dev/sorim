const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const memory = require('../skills/memory');
const survival = require('../skills/survival');
const food = require('../skills/food');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marigo-survival-'));

function makeBot(timeOfDay) {
    return {
        entity: { position: new Vec3(0, 64, 0) },
        entities: {},
        inventory: { items: () => [], slots: [] },
        health: 20,
        time: { timeOfDay },
        registry: { blocksByName: {} },
        findBlocks: () => [],
        blockAt: () => ({ name: 'air', boundingBox: 'empty' })
    };
}

function observation(food, inventory = {}) {
    return {
        health: 20,
        food,
        inventory
    };
}

try {
    memory.initialize('survival-test', { directory });
    const firstNight = makeBot(14000);
    assert.equal(
        survival.chooseImmediateAction(
            firstNight,
            observation(20),
            { id: 'L1_COLLECT_WOOD' }
        ).action,
        'emergency_shelter'
    );
    const submerged = makeBot(6000);
    submerged.entity.isInWater = true;
    submerged.oxygenLevel = 12;
    submerged.blockAt = position => position.y === 65
        ? { name: 'water', boundingBox: 'empty' }
        : { name: 'stone', boundingBox: 'block' };
    assert.equal(survival.needsAir(submerged), true);
    assert.equal(
        survival.chooseImmediateAction(
            submerged,
            observation(20),
            { id: 'L1_COLLECT_WOOD' }
        ).action,
        'escape_water'
    );
    memory.setSurfaceExit({ x: 0, y: 64, z: 0 });
    const earlyMorningPit = makeBot(6000);
    earlyMorningPit.entity.position = new Vec3(0, 61, 0);
    assert.equal(
        survival.chooseImmediateAction(
            earlyMorningPit,
            observation(20, { dirt: 3 }),
            { id: 'L1_COLLECT_WOOD' }
        ).action,
        'escape_pit'
    );
    const oneBlockBelowExit = makeBot(6000);
    oneBlockBelowExit.entity.position = new Vec3(0, 63, 0);
    assert.equal(
        survival.chooseImmediateAction(
            oneBlockBelowExit,
            observation(20, { dirt: 1 }),
            { id: 'L1_COLLECT_WOOD' }
        ).action,
        'escape_pit',
        'One block below a remembered surface exit is still underground'
    );
    const threatenedInShaft = makeBot(14000);
    threatenedInShaft.entity.position = new Vec3(0, 61, 0);
    threatenedInShaft.blockAt = position =>
        position.x === 0 && position.z === 0 && position.y >= 63
            ? { name: 'air', boundingBox: 'empty' }
            : { name: 'stone', boundingBox: 'block' };
    threatenedInShaft.entities.zombie = {
        id: 8,
        name: 'zombie',
        type: 'mob',
        position: new Vec3(0, 64, 0)
    };
    assert.equal(
        survival.chooseImmediateAction(
            threatenedInShaft,
            observation(18, { dirt: 2 }),
            { id: 'L1_COLLECT_WOOD' }
        ).action,
        'escape_pit',
        'A hostile above a recovery shaft must not cause an evade loop underground'
    );
    memory.clearSurfaceExit();
    const shallowDayPit = makeBot(6000);
    shallowDayPit.entity.position = new Vec3(0, 70, 0);
    shallowDayPit.blockAt = () => ({ name: 'stone', boundingBox: 'block' });
    assert.equal(
        survival.chooseImmediateAction(
            shallowDayPit,
            observation(20, { dirt: 2 }),
            { id: 'L1_COLLECT_WOOD' }
        ).action,
        'escape_pit',
        'A shallow sealed pit must not trap surface navigation'
    );
    memory.setBase({ x: 0, y: 64, z: 0 });

    const night = makeBot(14000);
    const day = makeBot(6000);
    const level = { id: 'L9_FOOD_LOOP' };

    night.entities.spider = {
        id: 7,
        name: 'spider',
        type: 'mob',
        position: new Vec3(3, 64, 0)
    };
    day.entities.spider = { ...night.entities.spider };
    assert.equal(survival.nearestHostile(day, 10), null);
    assert.equal(survival.nearestHostile(night, 10).name, 'spider');
    assert.equal(
        survival.chooseImmediateAction(night, observation(20), level).action,
        'evade_hostile'
    );
    assert.equal(
        survival.shouldInterruptForThreat(night, { name: 'zombie', distance: 11 }),
        false
    );
    assert.equal(
        survival.shouldInterruptForThreat(night, { name: 'zombie', distance: 5 }),
        true
    );
    assert.equal(
        survival.shouldInterruptForThreat(night, { name: 'skeleton', distance: 11 }),
        true
    );
    night.inventory.items = () => [{ name: 'stone_sword', count: 1 }];
    assert.equal(
        survival.shouldInterruptForThreat(night, { name: 'zombie', distance: 9 }),
        true
    );
    assert.equal(
        survival.chooseImmediateAction(night, observation(20), level).action,
        'fight_mob'
    );
    night.entities = {};

    assert.equal(
        survival.chooseImmediateAction(night, observation(8), level).action,
        'wait_safe'
    );
    assert.equal(
        survival.chooseImmediateAction(day, observation(8), level).action,
        'find_food'
    );
    assert.equal(
        survival.chooseImmediateAction(night, observation(8, { bread: 1 }), level).action,
        'eat_food'
    );
    assert.equal(food.foodCount({ cooked_beef: 2 }), 2);
    assert.equal(food.hasFoodStock({ bread: 16 }), true);
    assert.equal(food.hasFoodStock({ cooked_beef: 2 }), false);

    memory.setBase({ x: 0, y: 100, z: 0 });
    const underground = makeBot(6000);
    underground.entity.position = new Vec3(4, 63, 2);
    assert.equal(
        survival.chooseImmediateAction(
            underground,
            observation(20, { cobblestone: 32 }),
            { id: 'L10_STORAGE_AND_BASE_MEMORY' }
        ).action,
        'escape_pit'
    );
    console.log('Survival night and hunger priorities passed.');
} finally {
    memory.flush();
    fs.rmSync(directory, { recursive: true, force: true });
}
