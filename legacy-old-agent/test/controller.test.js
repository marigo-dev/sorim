const assert = require('assert');
const minecraftData = require('minecraft-data');
const { Vec3 } = require('vec3');
const Controller = require('../src/controller');

const registry = minecraftData('1.21');
const controller = Object.create(Controller.prototype);
controller.bot = {
    registry,
    blockAt: () => ({ name: 'air' }),
    findBlock: () => null,
    inventory: {
        items: () => [{ name: 'stone_axe' }]
    }
};
controller.lifeManager = { createPriorityGoals: () => [] };
controller.recentAttackerId = null;
controller.recentDamageAt = 0;
controller.escapeUntil = 0;
controller.treeMaintenanceIntervalMs = 60000;

assert.strictEqual(
    controller.hasMilestoneOrBetter(
        'wooden_pickaxe',
        { stone_pickaxe: 1 }
    ),
    true
);
assert.strictEqual(
    controller.hasMilestoneOrBetter(
        'stone_pickaxe',
        { wooden_pickaxe: 1 }
    ),
    false
);
assert.strictEqual(
    controller.hasMilestoneOrBetter(
        'stone_axe',
        { iron_axe: 1 }
    ),
    true
);
assert.strictEqual(
    controller.hasMilestoneOrBetter('furnace', { furnace: 1 }),
    true
);

controller.bot.entity = { position: new Vec3(40, 64, 0) };
controller.memory = { data: { base: { x: 0, y: 64, z: 0 } } };
assert.strictEqual(
    controller.shouldPrepareCraftAtBase(
        { type: 'acquire_item', item: 'iron_axe' },
        { type: 'explore', resource: 'herhangi_bir_odun' }
    ),
    false
);
assert.strictEqual(
    controller.shouldPrepareCraftAtBase(
        { type: 'acquire_item', item: 'iron_axe' },
        { type: 'craft', item: 'iron_axe', requiresTable: true }
    ),
    true
);

controller.memory = { data: { surfaceAnchor: { y: 70 } } };
assert.strictEqual(
    controller.shouldRecoverDeathItems(
        {
            x: 0,
            y: 55,
            z: 0,
            itemCount: 20,
            damageSource: 'zombie',
            items: [{ name: 'stone_pickaxe', count: 1 }]
        },
        {
            isNight: true,
            health: 20,
            food: 20,
            hostileMobs: [],
            inventory: { items: {} },
            position: { x: 0, y: 70, z: 0 }
        }
    ),
    false
);
assert.strictEqual(
    controller.shouldRecoverDeathItems(
        {
            x: 0,
            y: 55,
            z: 0,
            itemCount: 20,
            damageSource: 'zombie',
            items: [{ name: 'stone_pickaxe', count: 1 }]
        },
        {
            isNight: true,
            health: 20,
            food: 20,
            hostileMobs: [],
            inventory: { items: { stone_axe: 1 } },
            position: { x: 0, y: 70, z: 0 }
        }
    ),
    true
);

controller.memory = { data: { base: { x: 0, y: 64, z: 0 } } };
controller.bot.game = { difficulty: 'normal' };
controller.bot.inventory.items = () => [];
assert.strictEqual(
    controller.survivalOverrideForDanger(
        {
            isNight: true,
            food: 3,
            position: { x: 8, y: 64, z: 0 }
        },
        {
            type: 'flee',
            threat: 'zombie',
            distance: 4
        }
    ),
    null
);
assert.strictEqual(
    controller.survivalOverrideForDanger(
        {
            isNight: true,
            food: 20,
            position: { x: 8, y: 64, z: 0 }
        },
        {
            type: 'flee',
            threat: 'skeleton',
            distance: 7
        }
    ),
    null
);
assert.deepStrictEqual(
    controller.survivalOverrideForDanger(
        {
            isNight: true,
            food: 20,
            position: { x: 8, y: 64, z: 0 }
        },
        {
            type: 'flee',
            threat: 'zombie',
            distance: 7
        }
    ),
    {
        type: 'survive_night',
        reason: 'Gece silahsiz ve base yakin; rastgele kacmak yerine eve don'
    }
);
assert.strictEqual(
    controller.survivalOverrideForDanger(
        {
            isNight: true,
            food: 20,
            health: 11,
            position: { x: 8, y: 64, z: 0 }
        },
        {
            type: 'flee',
            threat: 'spider',
            distance: 1.4
        }
    ),
    null
);

controller.memory = {
    data: {
        shelter: { x: 0, y: 64, z: 0 },
        upgradedBase: null,
        mine: null,
        farm: null,
        ironArmorEquipped: false,
        beds: []
    }
};

controller.bot.inventory.items = () => [{ name: 'white_bed' }];
assert.deepStrictEqual(
    controller.createMiddleGameGoals({
        inventory: {
            items: {
                stone_sword: 1,
                oak_planks: 24
            }
        }
    }),
    [{
        type: 'place_bed',
        reason: 'Respawn noktasini ana usse tasimak icin yatagi kur'
    }]
);

controller.bot.inventory.items = () => [{ name: 'stone_axe' }];
assert.deepStrictEqual(
    controller.createMiddleGameGoals({
        inventory: {
            items: {
                stone_sword: 1,
                oak_planks: 24
            }
        }
    }),
    [{
        type: 'upgrade_base',
        reason: 'Ilk barinagi daha kullanisli bir ana usse cevir'
    }]
);

controller.memory.data.beds = [{ x: 1, y: 64, z: 0 }];
assert.deepStrictEqual(
    controller.createMiddleGameGoals({
        inventory: {
            items: {
                stone_sword: 1,
                oak_planks: 24
            }
        }
    }),
    [{
        type: 'upgrade_base',
        reason: 'Ilk barinagi daha kullanisli bir ana usse cevir'
    }]
);

controller.memory.data.beds = [];
controller.memory.data.upgradedBase = { x: 0, y: 64, z: 0 };
controller.memory.data.mine = { x: 8, y: 64, z: 0, branch: 0, lowestY: 64 };
controller.memory.data.farm = { x: 4, y: 64, z: 4, cropCount: 8 };
controller.memory.data.storageSystem = null;
assert.deepStrictEqual(
    controller.createMiddleGameGoals({
        isNight: false,
        nearbyMobs: [{ name: 'sheep', distance: 12 }],
        inventory: {
            items: {
                stone_sword: 1,
                iron_pickaxe: 1,
                torch: 12
            }
        }
    }),
    [{
        type: 'acquire_item',
        item: 'chest',
        count: 4,
        reason: 'Yiyecek, maden ve insaat malzemeleri icin kategorili depo hazirla'
    }]
);

controller.memory.data.storageSystem = { chests: [] };
assert.deepStrictEqual(
    controller.createMiddleGameGoals({
        isNight: false,
        nearbyMobs: [{ name: 'sheep', distance: 12 }],
        inventory: {
            items: {
                stone_sword: 1,
                iron_pickaxe: 1,
                torch: 12
            }
        }
    }),
    [{
        type: 'acquire_item',
        item: 'white_bed',
        count: 1,
        reason: 'Base ve tarla kuruldu; yakin koyun veya hazir yunden yatak edin'
    }]
);

controller.memory.data.beds = [{ x: 1, y: 64, z: 0 }];
controller.memory.data.farm = null;
controller.memory.data.storageSystem = { chests: [] };
controller.memory.data.mine = null;
controller.memory.data.upgradedBase = { x: 0, y: 64, z: 0 };
assert.deepStrictEqual(
    controller.createMiddleGameGoals({
        inventory: {
            items: {
                stone_sword: 1
            }
        }
    }),
    [{
        type: 'establish_mine',
        reason: 'Base yakininda guvenli capraz maden girisi kur'
    }]
);

controller.memory.data.mine = { x: 8, y: 64, z: 0, branch: 0, lowestY: 64 };
assert.deepStrictEqual(
    controller.createMiddleGameGoals({
        inventory: {
            items: {
                stone_sword: 1,
                torch: 15
            }
        }
    }),
    [{
        type: 'acquire_item',
        item: 'wheat_seeds',
        count: 8,
        reason: 'Tarla icin bugday tohumu topla'
    }]
);

controller.memory.data.farm = { x: 4, y: 64, z: 4, cropCount: 8 };
controller.memory.data.storageSystem = { chests: [] };
assert.deepStrictEqual(
    controller.createMiddleGameGoals({
        inventory: {
            items: {
                stone_sword: 1,
                torch: 15
            }
        }
    }),
    [{
        type: 'acquire_item',
        item: 'iron_pickaxe',
        count: 1,
        reason: 'Demir kazmaya gec'
    }]
);

assert.deepStrictEqual(
    controller.chooseDangerReflex({
        health: 20,
        hostileMobs: [{ id: 1, name: 'creeper', distance: 8 }]
    }),
    {
        type: 'flee',
        targetId: 1,
        threat: 'creeper',
        distance: 8,
        reason: 'creeper ile yakin savas riskli'
    }
);

assert.deepStrictEqual(
    controller.chooseDangerReflex({
        health: 20,
        hostileMobs: [{ id: 2, name: 'zombie', distance: 3 }]
    }),
    {
        type: 'fight',
        targetId: 2,
        threat: 'zombie',
        reason: 'zombie yakin tehdit'
    }
);

assert.deepStrictEqual(
    controller.chooseDangerReflex({
        health: 6,
        hostileMobs: [{ id: 2, name: 'zombie', distance: 3 }]
    }),
    {
        type: 'flee',
        targetId: 2,
        threat: 'zombie',
        distance: 3,
        reason: 'Can kritik: 6/20'
    }
);

const openSkyBlockAt = controller.bot.blockAt;
controller.bot.entity = { position: new Vec3(0, 58, 0) };
controller.bot.blockAt = () => ({ name: 'stone', boundingBox: 'block' });
assert.deepStrictEqual(
    controller.chooseDangerReflex({
        health: 20,
        position: { x: 0, y: 58, z: 0 },
        hostileMobs: [{ id: 3, name: 'zombie', distance: 3 }]
    }),
    {
        type: 'escape_pit',
        targetId: 3,
        threat: 'zombie',
        reason: 'zombie tehdidi var ama bot cukurda; once yukari cik'
    }
);
controller.bot.blockAt = openSkyBlockAt;

controller.escapeUntil = Date.now() + 1000;
assert.deepStrictEqual(
    controller.chooseDangerReflex({
        health: 12,
        hostileMobs: []
    }),
    {
        type: 'flee',
        targetId: null,
        threat: 'bilinmeyen_saldirgan',
        reason: 'Hasar sonrasi guvenli mesafe olustur'
    }
);

controller.lastFailedGoal = null;
controller.memory = {
    data: {
        shelter: null,
        base: null,
        upgradedBase: null,
        mine: null,
        farm: null,
        ironArmorEquipped: false,
        beautifulHouse: null,
        storageSystem: null,
        expandedFarm: null,
        treeGarden: null,
        deepMine: null,
        diamondArmorEquipped: false
    }
};

function freshObservation(items) {
    return {
        inventory: { items }
    };
}

assert.deepStrictEqual(
    controller.createCandidates(freshObservation({})),
    [
        {
            type: 'acquire_item',
            item: 'wooden_pickaxe',
            count: 1,
            reason: 'Minecraft gelisim hedefi'
        },
        {
            type: 'acquire_item',
            item: 'stone_pickaxe',
            count: 1,
            reason: 'Minecraft gelisim hedefi'
        }
    ]
);

controller.memory.data.shelter = { x: 0, y: 64, z: 0 };
controller.memory.data.base = { x: 0, y: 64, z: 0 };
assert.deepStrictEqual(
    controller.createCandidates(freshObservation({}))
        .map(goal => goal.item),
    ['wooden_pickaxe', 'stone_pickaxe']
);

controller.bot.game = { difficulty: 'peaceful' };
controller.memory.data.shelter = null;
controller.memory.data.base = null;
assert.deepStrictEqual(
    controller.createCandidates(freshObservation({
        stone_pickaxe: 1,
        stone_axe: 1,
        stone_sword: 1,
        furnace: 1
    })),
    [{
        type: 'acquire_item',
        item: 'cobblestone',
        count: 24,
        reason: 'Ilk barinak icin yapi malzemesi topla'
    }]
);

assert.deepStrictEqual(
    controller.createCandidates(freshObservation({
        stone_pickaxe: 1,
        stone_axe: 1,
        stone_sword: 1,
        furnace: 1,
        cobblestone: 24
    })),
    [{
        type: 'build_shelter',
        reason: 'Gece ve dusmanlar icin kalici ilk barinak kur'
    }]
);
controller.bot.game = { difficulty: 'normal' };

controller.memory.data = {
    shelter: { x: 0, y: 64, z: 0 },
    base: { x: 0, y: 64, z: 0 },
    upgradedBase: { x: 0, y: 64, z: 0 },
    mine: { x: 8, y: 64, z: 0, branch: 0, lowestY: 64 },
    farm: { x: 4, y: 64, z: 4, cropCount: 8 },
    ironArmorEquipped: true,
    beautifulHouse: { x: 0, y: 64, z: -14 },
    storageSystem: { chests: [] },
    expandedFarm: { cropCount: 24 },
    treeGarden: {
        spots: [],
        lastMaintainedAt: new Date().toISOString()
    },
    beds: [{ x: 1, y: 64, z: 0 }],
    deepMine: null,
    diamondArmorEquipped: false
};

assert.deepStrictEqual(
    controller.createCandidates(freshObservation({
        furnace: 1,
        torch: 16,
        iron_sword: 1,
        iron_axe: 1,
        diamond_pickaxe: 1,
        diamond_axe: 1,
        diamond_sword: 1
    })),
    [{
        type: 'establish_deep_mine',
        reason: 'Elmas seviyesi icin guvenli derin maden kolu ac'
    }]
);

controller.memory.data.deepMine = { x: 8, y: -32, z: 0 };
assert.deepStrictEqual(
    controller.createCandidates(freshObservation({
        furnace: 1,
        torch: 16,
        iron_pickaxe: 1,
        iron_sword: 1,
        iron_axe: 1
    }))[0],
    {
        type: 'acquire_item',
        item: 'diamond_pickaxe',
        count: 1,
        reason: 'Elmas alet: diamond_pickaxe'
    }
);

assert.deepStrictEqual(
    controller.createCandidates(freshObservation({
        furnace: 1,
        torch: 16,
        iron_sword: 1,
        iron_axe: 1,
        diamond_pickaxe: 1,
        diamond_axe: 1,
        diamond_sword: 1
    }))[0],
    {
        type: 'acquire_item',
        item: 'diamond_helmet',
        count: 1,
        reason: 'Elmas zirh parcasi: diamond_helmet'
    }
);

controller.memory.data.diamondArmorEquipped = true;
const idleGoal = controller.createCandidates(freshObservation({
    furnace: 1,
    torch: 16,
    iron_sword: 1,
    iron_axe: 1,
    diamond_pickaxe: 1,
    diamond_axe: 1,
    diamond_sword: 1,
    obsidian: 10,
    flint_and_steel: 1
}))[0];
assert.strictEqual(idleGoal.type, 'idle');
assert.match(idleGoal.reason, /Tum ana hedefler tamam/);

console.log('Controller tests passed.');
