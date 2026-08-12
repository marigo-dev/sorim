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
    firstNight.entities.skeleton = {
        id: 6,
        name: 'skeleton',
        type: 'mob',
        position: new Vec3(8, 64, 0)
    };
    assert.equal(
        survival.chooseImmediateAction(
            firstNight,
            observation(18),
            { id: 'L5_COLLECT_STONE' }
        ).action,
        'emergency_shelter',
        'An unarmed early bot must break skeleton line of sight instead of looping evade'
    );
    const edge = makeBot(6000);
    edge.entity.yaw = 0;
    edge.blockAt = position => position.z < 0
        ? { name: 'air', boundingBox: 'empty' }
        : (position.y <= 63
            ? { name: 'stone', boundingBox: 'block' }
            : { name: 'air', boundingBox: 'empty' });
    assert.equal(
        survival.isUnsafeForwardStep(edge),
        true,
        'Blind retreat must stop before a three-block drop'
    );
    const flatRetreat = makeBot(6000);
    flatRetreat.entity.yaw = 0;
    flatRetreat.blockAt = position => position.y <= 63
        ? { name: 'stone', boundingBox: 'block' }
        : { name: 'air', boundingBox: 'empty' };
    assert.equal(survival.isUnsafeForwardStep(flatRetreat), false);
    assert.equal(survival.canRetreatJump(flatRetreat), false, 'Flat retreat must not bunny-hop');
    const refugeSite = makeBot(14000);
    refugeSite.blockAt = position => position.y <= 63
        ? { name: 'stone', boundingBox: 'block', hardness: 1.5 }
        : { name: 'air', boundingBox: 'empty', hardness: 0 };
    assert.equal(
        survival.isSurfaceRefugeSiteSafe(refugeSite, new Vec3(0, 64, 0)),
        true,
        'A flat two-layer surface must accept a temporary refuge'
    );
    refugeSite.blockAt = position => {
        if (position.x === 1 && position.z === 0 && position.y === 63) {
            return { name: 'air', boundingBox: 'empty', hardness: 0 };
        }
        return position.y <= 63
            ? { name: 'stone', boundingBox: 'block', hardness: 1.5 }
            : { name: 'air', boundingBox: 'empty', hardness: 0 };
    };
    assert.equal(
        survival.isSurfaceRefugeSiteSafe(refugeSite, new Vec3(0, 64, 0)),
        false,
        'A refuge must reject footing that overlaps a mine opening'
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
    assert.equal(
        survival.chooseImmediateAction(
            oneBlockBelowExit,
            observation(20, { wooden_pickaxe: 1, dirt: 1 }),
            { id: 'L5_COLLECT_STONE' }
        ),
        null,
        'A planned stone staircase must not be interrupted as an accidental pit'
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
    threatenedInShaft.entities = {
        skeleton: {
            id: 12,
            name: 'skeleton',
            type: 'mob',
            position: new Vec3(8, 64, 0)
        }
    };
    threatenedInShaft.inventory.items = () => [{ name: 'stone_sword', count: 1 }];
    assert.equal(
        survival.chooseImmediateAction(
            threatenedInShaft,
            observation(20, { stone_sword: 1, dirt: 12 }),
            { id: 'L7_BUILD_SAFE_SHELTER' }
        ).action,
        'escape_pit',
        'A distant skeleton must not preempt the last steps of surface recovery'
    );
    threatenedInShaft.entities = {
        zombie: {
            id: 8,
            name: 'zombie',
            type: 'mob',
            position: new Vec3(2, 61, 0)
        }
    };
    threatenedInShaft.entities.zombie.position = new Vec3(2, 61, 0);
    threatenedInShaft.inventory.items = () => [{ name: 'stone_sword', count: 1 }];
    assert.equal(
        survival.chooseImmediateAction(
            threatenedInShaft,
            observation(18, { stone_sword: 1, dirt: 2 }),
            { id: 'L6_CRAFT_STONE_TOOLS' }
        ).action,
        'fight_mob',
        'An armed bot must fight a hostile sharing its pit before climbing'
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
    const leafyTreeBase = makeBot(6000);
    leafyTreeBase.blockAt = position => {
        if (position.y === 64 && (position.x !== 0 || position.z !== 0)) {
            return { name: 'oak_leaves', boundingBox: 'block' };
        }
        if (position.y <= 63) return { name: 'dirt', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
    };
    assert.equal(
        survival.chooseImmediateAction(
            leafyTreeBase,
            observation(20, { oak_log: 4 }),
            { id: 'L2_CRAFT_PLANKS' }
        ),
        null,
        'Leaves around a freshly cut tree must not be classified as a pit'
    );
    const farmlandSurface = makeBot(6000);
    farmlandSurface.entity.position = new Vec3(0.5, 62.9375, 0.5);
    farmlandSurface.blockAt = position => {
        if (position.y === 62) {
            return {
                name: 'farmland',
                boundingBox: 'block',
                shapes: [[0, 0, 0, 1, 0.9375, 1]]
            };
        }
        if (position.y === 63 && (position.x !== 0 || position.z !== 0)) {
            return { name: 'wheat', boundingBox: 'empty', shapes: [] };
        }
        return { name: 'air', boundingBox: 'empty', shapes: [] };
    };
    assert.equal(
        survival.isInPit(farmlandSurface),
        false,
        'Standing on farmland must use the air cell above it as the bot feet position'
    );
    assert.equal(
        survival.chooseImmediateAction(
            farmlandSurface,
            observation(20, { wheat_seeds: 8 }),
            { id: 'L17_ESTABLISH_WHEAT_FARM' }
        ),
        null,
        'Farm maintenance on partial-height blocks must not trigger pit recovery'
    );
    memory.setBase({ x: 0, y: 64, z: 0 });

    const night = makeBot(14000);
    const day = makeBot(6000);
    const level = { id: 'L9_FOOD_LOOP' };

    assert.equal(
        survival.chooseThreatAction(
            day,
            { id: 12, name: 'creeper', distance: 7.8, entity: {} },
            20
        ).action,
        'evade_hostile',
        'a nearby base must not override immediate creeper blast avoidance'
    );

    const exposedNearBase = makeBot(14000);
    exposedNearBase.entity.position = new Vec3(8, 64, 0);
    exposedNearBase.inventory.items = () => [{ name: 'stone_sword', count: 1 }];
    assert.equal(
        survival.chooseThreatAction(
            exposedNearBase,
            { id: 11, name: 'skeleton', distance: 7, entity: {} },
            16
        ).action,
        'return_base',
        'an exposed bot near its base should take cover instead of chasing a skeleton'
    );
    exposedNearBase.entity.position = new Vec3(30, 64, 0);
    assert.equal(
        survival.chooseThreatAction(
            exposedNearBase,
            { id: 11, name: 'skeleton', distance: 5, entity: {} },
            13
        ).action,
        'evade_hostile',
        'an unarmored low-health bot must disengage from ranged combat'
    );
    memory.clearBase();
    const exposedWithBlocks = makeBot(6000);
    exposedWithBlocks.inventory.items = () => [
        { name: 'stone_sword', count: 1 },
        { name: 'dirt', count: 12 }
    ];
    assert.equal(
        survival.chooseThreatAction(
            exposedWithBlocks,
            { id: 11, name: 'skeleton', distance: 10, entity: {} },
            15
        ).action,
        'emergency_shelter',
        'an unarmored wounded bot with blocks must take cover from ranged fire'
    );

    const cliffRetreat = makeBot(6000);
    cliffRetreat.blockAt = position => {
        const surfaceY = Math.hypot(position.x, position.z) <= 2 ? 63 : 58;
        return position.y <= surfaceY
            ? { name: 'stone', boundingBox: 'block' }
            : { name: 'air', boundingBox: 'empty' };
    };
    assert.equal(
        survival.findSafeRetreatPosition(cliffRetreat, new Vec3(-3, 64, 0)),
        null,
        'retreat selection must reject routes that cross a sudden drop'
    );
    memory.setBase({ x: 0, y: 64, z: 0 });
    exposedNearBase.entity.position = new Vec3(8, 64, 0);

    day.entities.zombie = {
        id: 9,
        name: 'zombie',
        type: 'mob',
        position: new Vec3(3, 64, 0)
    };
    assert.equal(survival.canFightUnarmed(day, { name: 'zombie' }, 20), false);
    assert.equal(
        survival.chooseImmediateAction(day, observation(20), level).action,
        'fight_mob',
        'a healthy unarmed bot may defend itself against one zombie at contact range'
    );
    day.entities.zombie2 = {
        id: 10,
        name: 'zombie',
        type: 'mob',
        position: new Vec3(4, 64, 0)
    };
    assert.equal(survival.canFightUnarmed(day, { name: 'zombie' }, 20), false);
    assert.equal(
        survival.chooseImmediateAction(day, observation(20), level).action,
        'evade_hostile',
        'an unarmed bot must not take on a group'
    );
    day.entities = {};

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
        false,
        'a mob outside the shelter must not pull the bot out of its secured base'
    );
    night.entity.position = new Vec3(10, 64, 0);
    assert.equal(
        survival.shouldInterruptForThreat(night, { name: 'zombie', distance: 5 }),
        true
    );
    assert.equal(
        survival.shouldInterruptForThreat(night, { name: 'skeleton', distance: 11 }),
        false,
        'a distant skeleton must not preempt work before it actually damages the bot'
    );
    night.health = 18;
    assert.equal(
        survival.shouldInterruptForThreat(night, { name: 'skeleton', distance: 11 }),
        true,
        'a ranged hit must trigger combat response across the skeleton danger radius'
    );
    night.health = 20;
    night.canSeeEntity = () => false;
    assert.equal(
        survival.shouldInterruptForThreat(night, {
            name: 'skeleton',
            distance: 11,
            entity: night.entities.spider
        }),
        false,
        'a ranged mob behind solid cover must not interrupt useful work'
    );
    assert.equal(
        survival.shouldInterruptForThreat(night, {
            name: 'skeleton',
            distance: 3,
            entity: night.entities.spider
        }),
        true,
        'a very close mob remains actionable even when visibility is uncertain'
    );
    delete night.canSeeEntity;
    night.entity.position = new Vec3(11, 64, 0);
    night.inventory.items = () => [{ name: 'stone_sword', count: 1 }];
    assert.equal(
        survival.shouldInterruptForThreat(night, { name: 'zombie', distance: 9 }),
        true
    );
    assert.equal(
        survival.chooseImmediateAction(night, observation(20), level).action,
        'return_base',
        'an armed bot should still prefer its nearby base over a non-contact night fight'
    );
    night.entities = {};
    night.entity.position = new Vec3(0, 64, 0);

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
    assert.equal(food.hasActionableConvertibleFood({ beef: 5, oak_log: 1 }), false);
    assert.equal(food.hasActionableConvertibleFood({ beef: 5, cobblestone: 8, oak_log: 1 }), true);
    assert.equal(food.hasActionableConvertibleFood({ wheat: 3 }), true);

    memory.setBase({ x: 0, y: 100, z: 0 });
    const underground = makeBot(6000);
    underground.entity.position = new Vec3(4, 63, 2);
    underground.blockAt = position =>
        position.x === 4 && position.z === 2
            ? { name: 'air', boundingBox: 'empty', skyLight: 0 }
            : { name: 'stone', boundingBox: 'block', skyLight: 0 };
    assert.equal(
        survival.chooseImmediateAction(
            underground,
            observation(20, { cobblestone: 32 }),
            { id: 'L10_STORAGE_AND_BASE_MEMORY' }
        ).action,
        'escape_pit'
    );
    memory.setBase({ x: 0, y: 69, z: 0 });
    const falseSurface = makeBot(14000);
    falseSurface.entity.position = new Vec3(12, 66, 8);
    falseSurface.blockAt = position =>
        position.x === 12 && position.z === 8
            ? { name: 'air', boundingBox: 'empty', skyLight: 0 }
            : { name: 'stone', boundingBox: 'block', skyLight: 0 };
    assert.equal(
        survival.chooseImmediateAction(
            falseSurface,
            observation(20, { stone_sword: 1, dirt: 20 }),
            { id: 'L9_FOOD_LOOP' }
        ).action,
        'escape_pit',
        'night handling must not interrupt recovery below the remembered base floor'
    );
    memory.setBase({ x: 0, y: 100, z: 0 });
    assert.equal(
        survival.shouldUseEmergencyShaft(
            new Vec3(2, 68, 2),
            new Vec3(0, 70, 0),
            false,
            0
        ),
        true,
        'a shallow starter shaft should use deterministic pillar recovery'
    );
    assert.equal(
        survival.shouldUseEmergencyShaft(
            new Vec3(2, 55, 2),
            new Vec3(0, 70, 0),
            false,
            0
        ),
        false,
        'a deep mine must preserve its route instead of blind pillaring'
    );
    assert.equal(
        survival.shouldUseEmergencyShaft(
            new Vec3(2, 68, 2),
            new Vec3(0, 70, 0),
            true,
            0
        ),
        false,
        'base-aware recovery should keep using the planned route'
    );
    assert.equal(
        survival.shouldUseShallowBaseShaft(
            new Vec3(12, 68, 8),
            { x: 0, y: 70, z: 0 }
        ),
        true,
        'a route-less two-block base pit should use a physical pillar exit'
    );
    assert.equal(
        survival.shouldUseShallowBaseShaft(
            new Vec3(12, 60, 8),
            { x: 0, y: 70, z: 0 }
        ),
        false,
        'a deep base mine must not pillar blindly'
    );
    const plannedRoute = [
        { x: 9, y: 69, z: 134 },
        { x: 10, y: 68, z: 135 },
        { x: 11, y: 67, z: 136 }
    ];
    assert.equal(
        survival.isMineRouteRelevant(new Vec3(10, 67, 136), plannedRoute),
        true,
        'a bot inside its planned mine must keep the saved return route'
    );
    assert.equal(
        survival.isMineRouteRelevant(new Vec3(5, 57, 153), plannedRoute),
        false,
        'an old route across the world must not control accidental pit recovery'
    );
    console.log('Survival night and hunger priorities passed.');
} finally {
    memory.flush();
    fs.rmSync(directory, { recursive: true, force: true });
}
