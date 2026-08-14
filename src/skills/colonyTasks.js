const { Vec3 } = require('vec3');

const colonyMemory = require('./colonyMemory');
const sharedStorage = require('./sharedStorage');
const LeaseManager = require('../agent/leaseManager');

const leaseManager = new LeaseManager(colonyMemory, {
    defaultTtlMs: Number(process.env.COLONY_LEASE_TTL_MS || 120000)
});

const LOG_ITEMS = [
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'cherry_log',
    'mangrove_log',
    'pale_oak_log'
];

const PLANK_ITEMS = [
    'oak_planks',
    'birch_planks',
    'spruce_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'cherry_planks',
    'mangrove_planks',
    'pale_oak_planks'
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
    colonyMemory.prepareSettlement(vectorToObject(center));
    colonyMemory.initializeSettlement(vectorToObject(center));
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

function selectTask(bot, agent, options = {}) {
    const inventory = countInventory(bot);
    const shared = colonyMemory.load().sharedStorage?.inventory || {};

    const deposit = selectDeposit(inventory);
    if (deposit) {
        const call = {
            tool: 'deposit_shared_storage',
            args: deposit,
            reason: `${agent.role}: deposit useful colony resource`
        };
        return options.claim === false ? call : leaseTask(call, agent);
    }

    let selected = null;
    if (agent.role === 'builder') {
        selected = selectBuilderTask(shared, inventory);
    }
    if (agent.role === 'farmer_miner') {
        selected = selectFarmerMinerTask(shared, inventory);
    }
    if (agent.role === 'farmer') selected = selectFarmerTask(inventory);
    if (agent.role === 'rancher') {
        selected = tool('care_for_animals', {}, 'rancher: feed and breed colony livestock');
    }
    if (agent.role === 'miner') selected = selectMinerTask(shared, inventory);
    if (agent.role === 'lumberjack') selected = selectLumberjackTask(inventory);
    if (agent.role === 'fisher') selected = tool('fish', {}, 'fisher: supply the colony from open water');
    if (agent.role === 'quartermaster') {
        selected = tool('count_shared_storage', {}, 'quartermaster: audit shared colony stock');
    }
    selected = selected || {
        tool: 'wait_safe',
        args: { ms: 1000 },
        reason: `${agent.role}: no colony task`
    };
    return options.claim === false ? selected : leaseTask(selected, agent);
}

function leaseTask(call, agent) {
    if (!call || ['wait_safe', 'count_shared_storage'].includes(call.tool)) return call;
    const key = taskLeaseKey(call);
    const lease = leaseManager.claim(key, agent.name, {
        role: agent.role,
        tool: call.tool,
        args: call.args || {}
    });
    if (!lease) {
        return tool('wait_safe', { ms: 1200 }, `${agent.role}: work is leased to another citizen`);
    }
    return { ...call, lease };
}

function taskLeaseKey(call) {
    const args = Object.entries(call.args || {}).sort(([left], [right]) => left.localeCompare(right));
    return `task:${call.tool}:${JSON.stringify(Object.fromEntries(args))}`;
}

function releaseLease(call, owner) {
    return call?.lease?.key ? leaseManager.release(call.lease.key, owner) : false;
}

function releaseAgentLeases(owner) {
    return leaseManager.releaseOwner(owner);
}

function selectFarmerTask(inventory) {
    const foodName = FOOD_ITEMS.find(name => (inventory[name] || 0) > 0);
    if (foodName) {
        return tool('deposit_shared_storage', {
            item: foodName,
            count: inventory[foodName]
        }, 'farmer: deposit produced food');
    }
    return tool('maintain_food_supply', {}, 'farmer: maintain crops, then tend livestock while crops grow');
}

function selectMinerTask(shared, inventory) {
    if ((inventory.raw_iron || 0) > 0) {
        return tool('deposit_shared_storage', { item: 'raw_iron', count: inventory.raw_iron }, 'miner: deposit raw iron');
    }
    if ((inventory.cobblestone || 0) > 32 && (shared.cobblestone || 0) < 32) {
        return tool('deposit_shared_storage', {
            item: 'cobblestone',
            count: Math.min(16, inventory.cobblestone - 32)
        }, 'miner: maintain building stock while keeping a mining reserve');
    }
    if ((shared.cobblestone || 0) < 32) return tool('collect_stone', { count: 16 }, 'miner: gather starter stone');
    return tool('mine_iron', { count: 16 }, 'miner: operate the colony iron mine');
}

function selectLumberjackTask(inventory) {
    const logName = LOG_ITEMS.find(name => (inventory[name] || 0) > 0);
    if (logName && inventory[logName] >= 16) {
        return tool('deposit_shared_storage', { item: logName, count: inventory[logName] }, 'lumberjack: deposit logs');
    }
    const saplingName = Object.keys(inventory).find(name => name.endsWith('_sapling') && inventory[name] >= 1);
    if (saplingName) return tool('replant_sapling', {}, 'lumberjack: replant outside protected builds');
    return tool('mine_block', { target: 'any_log' }, 'lumberjack: harvest a safe natural tree');
}

function tool(name, args, reason) {
    return { tool: name, args, reason };
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
    taskLeaseKey,
    releaseLease,
    releaseAgentLeases,
    parseCenter,
    countInventory
};
