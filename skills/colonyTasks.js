const { Vec3 } = require('vec3');

const colonyMemory = require('./colonyMemory');
const sharedStorage = require('./sharedStorage');

const LOG_ITEMS = [
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'cherry_log',
    'mangrove_log'
];

const PLANK_ITEMS = [
    'oak_planks',
    'birch_planks',
    'spruce_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'cherry_planks',
    'mangrove_planks'
];

const FOOD_ITEMS = [
    'bread',
    'cooked_beef',
    'cooked_porkchop',
    'cooked_mutton',
    'cooked_chicken',
    'beef',
    'porkchop',
    'mutton',
    'chicken',
    'apple',
    'carrot',
    'potato',
    'baked_potato'
];

function bootstrap(center, agents) {
    colonyMemory.reset(vectorToObject(center));
    colonyMemory.setSharedStorage({
        position: vectorToObject(center),
        categories: ['building_blocks', 'food', 'tools', 'ores'],
        mode: 'survival_chest'
    });

    for (const agent of agents) {
        colonyMemory.setBotBase(agent.name, {
            role: agent.role,
            base: vectorToObject(agent.base),
            status: 'ready'
        });
    }

    ensureDefaultRequests();
}

function ensureDefaultRequests() {
    const defaults = [
        {
            requester: 'builder',
            item: 'cobblestone',
            count: 32,
            purpose: 'starter_base'
        },
        {
            requester: 'builder',
            item: 'oak_planks',
            count: 16,
            purpose: 'starter_base'
        },
        {
            requester: 'colony',
            item: 'food',
            count: 16,
            purpose: 'survival_stock'
        }
    ];

    for (const request of defaults) colonyMemory.addRequest(request);
}

async function ensureSharedStorageReady(bot, center) {
    await sharedStorage.registerSharedStorage(center);
    return sharedStorage.ensureSharedStorage(bot, center);
}

function selectTask(bot, agent) {
    const inventory = countInventory(bot);
    const shared = colonyMemory.load().sharedStorage?.inventory || {};

    const deposit = selectDeposit(inventory);
    if (deposit) {
        return {
            tool: 'deposit_shared_storage',
            args: deposit,
            reason: `${agent.role}: deposit useful colony resource`
        };
    }

    if (agent.role === 'builder') {
        return selectBuilderTask(shared, inventory);
    }

    if (agent.role === 'farmer_miner') {
        return selectFarmerMinerTask(shared, inventory);
    }

    return {
        tool: 'wait_safe',
        args: { ms: 1000 },
        reason: `${agent.role}: no colony task`
    };
}

function selectBuilderTask(shared, inventory) {
    if ((inventory.cobblestone || 0) >= 4) {
        return {
            tool: 'build_colony_marker',
            args: { material: 'cobblestone' },
            reason: 'builder: spend carried blocks on first colony marker'
        };
    }

    const cobbleRequest = findRequest('cobblestone');
    if (cobbleRequest && (shared.cobblestone || 0) >= 12 && (inventory.cobblestone || 0) < 12) {
        colonyMemory.claimRequest(cobbleRequest.id, 'builder');
        return {
            tool: 'withdraw_shared_storage',
            args: { item: 'cobblestone', count: 12 },
            reason: 'builder: withdraw cobblestone for starter base'
        };
    }

    if ((inventory.cobblestone || 0) >= 12) {
        if (cobbleRequest) colonyMemory.completeRequest(cobbleRequest.id, 'builder', 12);
        return {
            tool: 'build_colony_marker',
            args: { material: 'cobblestone' },
            reason: 'builder: build a small survival base marker'
        };
    }

    const planksRequest = findRequest('oak_planks');
    const plankName = PLANK_ITEMS.find(name => (shared[name] || 0) >= 8);
    if (planksRequest && plankName && totalPlanks(inventory) < 8) {
        colonyMemory.claimRequest(planksRequest.id, 'builder');
        return {
            tool: 'withdraw_shared_storage',
            args: { item: plankName, count: 8 },
            reason: 'builder: withdraw planks for shelter detail'
        };
    }

    return {
        tool: 'wait_safe',
        args: { ms: 1200 },
        reason: 'builder: waiting for requested materials'
    };
}

function selectFarmerMinerTask(shared, inventory) {
    const foodRequest = findRequest('food');
    const foodName = FOOD_ITEMS.find(name => (inventory[name] || 0) > 0);
    if (foodRequest && foodName) {
        return {
            tool: 'deposit_shared_storage',
            args: { item: foodName, count: inventory[foodName] },
            reason: 'farmer_miner: deposit food stock'
        };
    }

    const cobbleRequest = findRequest('cobblestone');
    if (cobbleRequest && (shared.cobblestone || 0) < cobbleRequest.count) {
        if ((inventory.cobblestone || 0) >= 16) {
            colonyMemory.claimRequest(cobbleRequest.id, 'farmer_miner');
            return {
                tool: 'deposit_shared_storage',
                args: { item: 'cobblestone', count: Math.min(16, inventory.cobblestone) },
                reason: 'farmer_miner: deliver mined cobblestone'
            };
        }
        return {
            tool: 'collect_stone',
            args: { count: 16 },
            reason: 'farmer_miner: collect cobblestone for builder request'
        };
    }

    const plankRequest = findRequest('oak_planks');
    if (plankRequest && totalPlanks(shared) < plankRequest.count) {
        const plankName = PLANK_ITEMS.find(name => (inventory[name] || 0) >= 8);
        if (plankName) {
            colonyMemory.claimRequest(plankRequest.id, 'farmer_miner');
            return {
                tool: 'deposit_shared_storage',
                args: { item: plankName, count: Math.min(8, inventory[plankName]) },
                reason: 'farmer_miner: deliver planks'
            };
        }
        const logName = LOG_ITEMS.find(name => (inventory[name] || 0) > 0);
        if (logName) {
            return {
                tool: 'craft_item',
                args: { item: logName.replace(/_log$/, '_planks'), count: 8 },
                reason: 'farmer_miner: convert logs to planks'
            };
        }
        return {
            tool: 'mine_block',
            args: { target: 'any_log' },
            reason: 'farmer_miner: gather wood for planks request'
        };
    }

    return {
        tool: 'find_food',
        args: {},
        reason: 'farmer_miner: improve colony food stock'
    };
}

function selectDeposit(inventory) {
    if ((inventory.raw_iron || 0) > 0) return { item: 'raw_iron', count: inventory.raw_iron };
    if ((inventory.iron_ingot || 0) > 0) return { item: 'iron_ingot', count: inventory.iron_ingot };
    if ((inventory.coal || 0) > 16) return { item: 'coal', count: inventory.coal - 16 };
    if ((inventory.cobblestone || 0) > 32) return { item: 'cobblestone', count: inventory.cobblestone - 32 };
    const plankName = PLANK_ITEMS.find(name => (inventory[name] || 0) > 16);
    if (plankName) return { item: plankName, count: inventory[plankName] - 16 };
    return null;
}

function findRequest(item) {
    return colonyMemory.activeRequests()
        .filter(request => request.item === item || (item === 'food' && request.item === 'food'))
        .filter(request => request.status === 'open' || request.status === 'claimed')
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
}

function countInventory(bot) {
    const counts = {};
    for (const item of bot.inventory.items()) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    return counts;
}

function totalPlanks(inventory) {
    return PLANK_ITEMS.reduce((sum, name) => sum + (inventory[name] || 0), 0);
}

function vectorToObject(vector) {
    return { x: vector.x, y: vector.y, z: vector.z };
}

function parseCenter(value) {
    if (value instanceof Vec3) return value.floored();
    const [x, y, z] = String(value).split(',').map(Number);
    if ([x, y, z].some(number => !Number.isFinite(number))) {
        throw new Error('COLONY_CENTER must be formatted like "1800,70,0"');
    }
    return new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
}

module.exports = {
    bootstrap,
    ensureDefaultRequests,
    ensureSharedStorageReady,
    selectTask,
    parseCenter,
    countInventory
};
