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

const food = require('./skills/food');
const iron = require('./skills/iron');
const memory = require('./skills/memory');
const shelter = require('./skills/shelter');
const storage = require('./skills/storage');
const homestead = require('./skills/homestead');
const { assessMiningKit } = require('./agent/progressionContracts');

const FULL_IRON_TARGET = 44;
const SHELTER_STONE_TARGET = 24;
const SHELTER_PLANK_TARGET = 60;

const LEVELS = [
    {
        id: 'L1_COLLECT_WOOD',
        goal: 'Collect at least 4 logs. Search for trees and cut trunk logs.',
        allowedActions: ['mine', 'explore', 'idle'],
        complete: (observation, tree) =>
            tree.progress.maxWoodUnits >= 4 ||
            hasCraftedWoodProgress(observation.inventory)
    },
    {
        id: 'L2_CRAFT_PLANKS',
        goal: 'Craft at least 16 planks from logs; unlock the early tool chain.',
        allowedActions: ['craft', 'idle'],
        complete: (observation, tree) =>
            tree.progress.maxPlanks >= 16 ||
            tree.progress.maxCobblestone >= 1 ||
            hasPickaxeProgress(observation.inventory)
    },
    {
        id: 'L3_CRAFT_TABLE',
        goal: 'Craft and place one crafting table.',
        allowedActions: ['craft', 'place', 'idle'],
        complete: (observation, tree) =>
            hasPickaxeProgress(observation.inventory) ||
            tree.progress.hasCraftingTable ||
            observation.hasPlacedCraftingTable === true ||
            observation.nearbyBlocks.some(block => block.name === 'crafting_table' && block.distance <= 16)
    },
    {
        id: 'L4_CRAFT_WOODEN_PICKAXE',
        goal: 'Craft a wooden pickaxe.',
        allowedActions: ['craft', 'place', 'idle'],
        complete: (observation, tree) =>
            hasPickaxeProgress(observation.inventory) ||
            tree.progress.maxCobblestone >= 1
    },
    {
        id: 'L5_COLLECT_STONE',
        goal: 'Dig a safe staircase, find stone, collect 16 cobblestone, then return upward.',
        allowedActions: ['collect_stone', 'idle'],
        complete: (observation, tree) =>
            (observation.inventory.cobblestone || 0) >= 16 ||
            tree.progress.maxCobblestone >= 16 ||
            hasUpgradedPickaxe(observation.inventory)
    },
    {
        id: 'L6_CRAFT_STONE_TOOLS',
        goal: 'Craft a stone pickaxe, stone axe, and stone sword.',
        allowedActions: ['craft_stone_tools', 'craft', 'idle'],
        complete: observation => hasStoneTools(observation.inventory)
    },
    {
        id: 'L7_BUILD_SAFE_SHELTER',
        goal: 'Build a tidy enclosed 5x5 stone-and-wood house with a door, crafting table, and chest.',
        allowedActions: ['mine', 'collect_stone', 'craft', 'build_shelter', 'idle'],
        complete: observation => Boolean(observation.base)
    },
    {
        id: 'L8_SURVIVAL_MANAGER',
        goal: 'Ensure the survival manager runs before the main loop.',
        allowedActions: ['idle'],
        complete: observation => observation.survivalReady === true
    },
    {
        id: 'L9_FOOD_LOOP',
        goal: 'Keep at least 16 edible items in reserve; if no food is nearby, temporarily move on.',
        allowedActions: ['eat_food', 'find_food', 'maintain_food_supply', 'idle'],
        complete: observation =>
            food.hasFoodStock(observation.inventory, 16) ||
            (food.isTemporarilyUnavailable() &&
                !food.hasActionableConvertibleFood(observation.inventory))
    },
    {
        id: 'L10_STORAGE_AND_BASE_MEMORY',
        goal: 'Place a chest near the base and organize excess inventory.',
        allowedActions: ['organize_storage', 'idle'],
        complete: observation =>
            observation.hasUsableChest === true || memory.hasPlacedBlock('chest')
    },
    {
        id: 'L17_ESTABLISH_WHEAT_FARM',
        goal: 'Establish a hydrated wheat farm near base, using natural water before iron if possible.',
        allowedActions: ['establish_wheat_farm', 'collect_stone', 'craft', 'idle'],
        complete: observation => observation.farmReady === true
    },
    {
        id: 'L11_SECURE_BED',
        goal: 'Collect three matching wool, craft a bed, and place it near the base.',
        allowedActions: ['secure_bed', 'mine', 'idle'],
        complete: observation =>
            observation.hasBed === true || homestead.isBedTemporarilyUnavailable()
    },
    {
        id: 'L12_PREPARE_MINING_KIT',
        goal: 'Prepare furnace, fuel, torches, food, stone tools, and block stock for iron mining.',
        allowedActions: ['prepare_mining_kit', 'eat_food', 'find_food', 'mine', 'craft', 'idle'],
        complete: observation => hasMiningKit(observation)
    },
    {
        id: 'L13_SAFE_IRON_MINE',
        goal: 'Open a controlled stair mine from base, place torches, and search for iron.',
        allowedActions: ['mine_iron', 'eat_food', 'organize_storage', 'idle'],
        complete: observation =>
            rawIronPotential(observation.inventory) >= 16 ||
            iron.hasIronCoreKit(observation.inventory)
    },
    {
        id: 'L14_COLLECT_RAW_IRON',
        goal: 'Collect enough raw iron for iron tools, shield, and an 8 ingot reserve.',
        allowedActions: ['mine_iron', 'eat_food', 'organize_storage', 'idle'],
        complete: (observation, tree) =>
            tree.progress.maxIronPotential >= 17 ||
            hasIronInFurnaceTransition(observation.inventory) ||
            iron.hasIronCoreKit(observation.inventory)
    },
    {
        id: 'L15_SMELT_IRON',
        goal: 'Smelt raw iron into iron ingots using furnace and fuel.',
        allowedActions: ['smelt_item', 'mine_iron', 'prepare_mining_kit', 'idle'],
        complete: observation =>
            smeltedIronPotential(observation.inventory) >= 17 ||
            iron.hasIronCoreKit(observation.inventory)
    },
    {
        id: 'L16_CRAFT_IRON_KIT',
        goal: 'Craft iron pickaxe, sword, axe, and shield while preserving 8 iron ingots.',
        allowedActions: ['craft_iron_kit', 'craft', 'idle'],
        complete: observation => iron.hasIronCoreItems(observation.inventory)
    },
    {
        id: 'L18_COLLECT_ARMOR_IRON',
        goal: 'Collect enough additional iron for full armor, the farm bucket, and an 8 ingot reserve.',
        allowedActions: ['mine_iron', 'eat_food', 'organize_storage', 'idle'],
        complete: (observation, tree) =>
            tree.progress.maxIronPotential >= FULL_IRON_TARGET
    },
    {
        id: 'L19_SMELT_ARMOR_IRON',
        goal: 'Smelt iron until tools, bucket, armor budget, and reserve represent 44 ingots.',
        allowedActions: ['smelt_item', 'mine_iron', 'prepare_mining_kit', 'idle'],
        complete: observation => smeltedIronPotential(observation.inventory) >= FULL_IRON_TARGET
    },
    {
        id: 'L20_CRAFT_IRON_ARMOR',
        goal: 'Craft and equip full iron armor while preserving 8 iron ingots.',
        allowedActions: ['craft_iron_armor', 'craft', 'idle'],
        complete: observation =>
            iron.hasFullIronArmor(observation.inventory) &&
            (observation.inventory.iron_ingot || 0) >= 8
    }
];

class SkillTree {
    constructor() {
        this.progress = {
            maxWoodUnits: memory.getProgress('maxWoodUnits'),
            maxPlanks: memory.getProgress('maxPlanks'),
            maxCobblestone: memory.getProgress('maxCobblestone'),
            maxIronPotential: memory.getProgress('maxIronPotential'),
            hasCraftingTable: memory.getProgress('hasCraftingTable') >= 1
        };
    }

    getLevel(observation) {
        this.updateProgress(observation);
        return LEVELS.find(level => !level.complete(observation, this)) ||
            {
                id: 'L21_STABLE_SURVIVAL',
                goal: 'Core loop complete. Maintain food, wood, planks, and storage.',
                allowedActions: [
                    'mine',
                    'explore',
                    'craft',
                    'eat_food',
                    'find_food',
                    'maintain_food_supply',
                    'organize_storage',
                    'prepare_mining_kit',
                    'mine_iron',
                    'smelt_item',
                    'craft_iron_kit',
                    'craft_iron_armor',
                    'establish_wheat_farm',
                    'idle'
                ],
                complete: () => false
            };
    }

    getForcedAction(observation, level) {
        const inventory = observation.inventory;

        if (level.id === 'L1_COLLECT_WOOD') {
            const visibleLog = nearestVisibleLog(observation);
            if (visibleLog) {
                return {
                    action: 'mine',
                    target: 'any_log',
                    reason: `Level 1: cut the nearest safe tree (${visibleLog.name} observed)`
                };
            }
            return {
                action: 'mine',
                target: 'any_log',
                reason: 'Level 1: search and cut the nearest tree'
            };
        }

        if (level.id === 'L2_CRAFT_PLANKS') {
            const logName = LOG_ITEMS.find(name => (inventory[name] || 0) > 0);
            return {
                action: 'craft',
                item: plankForLog(logName || 'oak_log'),
                count: 16 - totalPlanks(inventory),
                reason: 'Level 2: craft planks'
            };
        }

        if (level.id === 'L3_CRAFT_TABLE') {
            if ((inventory.crafting_table || 0) > 0) {
                return {
                    action: 'place',
                    item: 'crafting_table',
                    reason: 'Level 3: place crafting table'
                };
            }
            return {
                action: 'craft',
                item: 'crafting_table',
                count: 1,
                reason: 'Level 3: craft crafting table'
            };
        }

        if (level.id === 'L4_CRAFT_WOODEN_PICKAXE') {
            if ((inventory.stick || 0) < 2) {
                return {
                    action: 'craft',
                    item: 'stick',
                    count: 2,
                    reason: 'Level 4: craft sticks for pickaxe'
                };
            }
            return {
                action: 'craft',
                item: 'wooden_pickaxe',
                count: 1,
                reason: 'Level 4: craft wooden pickaxe'
            };
        }

        if (level.id === 'L5_COLLECT_STONE') {
            return {
                action: 'collect_stone',
                count: Math.max(1, 16 - (inventory.cobblestone || 0)),
                reason: 'Level 5: collect cobblestone with a safe staircase'
            };
        }

        if (level.id === 'L6_CRAFT_STONE_TOOLS') {
            return {
                action: 'craft_stone_tools',
                reason: 'Level 6: craft stone pickaxe, axe, and sword'
            };
        }

        if (level.id === 'L7_BUILD_SAFE_SHELTER') {
            if (shelter.needsOnlyUtilityRepair()) {
                return {
                    action: 'build_shelter',
                    reason: 'Level 7: repair the existing shelter utility and door'
                };
            }
            const planks = totalPlanks(inventory);
            const cobblestone = inventory.cobblestone || 0;
            if (cobblestone < SHELTER_STONE_TARGET) {
                return {
                    action: 'collect_stone',
                    count: SHELTER_STONE_TARGET - cobblestone,
                    reason: 'Level 7: collect stone for the 5x5 house foundation and roof trim'
                };
            }
            if (planks < SHELTER_PLANK_TARGET) {
                const logName = LOG_ITEMS.find(name => (inventory[name] || 0) > 0);
                if (logName) {
                    const deficit = Math.max(SHELTER_PLANK_TARGET - planks, 4);
                    return {
                        action: 'craft',
                        item: plankForLog(logName),
                        count: Math.min(deficit, (inventory[logName] || 0) * 4),
                        reason: 'Level 7: prepare enough blocks for the shelter shell'
                    };
                }
                return {
                    action: 'mine',
                    target: 'any_log',
                    reason: 'Level 7: collect wood for the 5x5 house walls and utilities'
                };
            }
            return {
                action: 'build_shelter',
                reason: 'Level 7: build the first 5x5 stone-and-wood house'
            };
        }

        if (level.id === 'L9_FOOD_LOOP') {
            if (foodScore(inventory) > 0 && observation.food < 20) {
                return {
                    action: 'eat_food',
                    reason: 'Level 9: use food reserve'
                };
            }
            if (observation.farmReady) {
                return {
                    action: 'maintain_food_supply',
                    reason: 'Level 9: use and expand the base food farm'
                };
            }
            return {
                action: 'find_food',
                reason: 'Level 9: collect minimum food reserve'
            };
        }

        if (level.id === 'L10_STORAGE_AND_BASE_MEMORY') {
            return {
                action: 'organize_storage',
                reason: 'Level 10: place chest and organize inventory'
            };
        }

        if (level.id === 'L11_SECURE_BED') {
            return {
                action: 'secure_bed',
                reason: 'Level 11: secure and place a bed at base'
            };
        }

        if (level.id === 'L12_PREPARE_MINING_KIT') {
            if (!food.hasFoodStock(inventory, 16)) {
                return {
                    action: observation.farmReady ? 'maintain_food_supply' : 'find_food',
                    reason: observation.farmReady
                        ? 'Level 12: grow or harvest the base farm until sixteen food are ready'
                        : 'Level 12: collect food before mining'
                };
            }
            return {
                action: 'prepare_mining_kit',
                reason: 'Level 12: prepare furnace, fuel, torches, and blocks'
            };
        }

        if (level.id === 'L13_SAFE_IRON_MINE') {
            return {
                action: 'mine_iron',
                count: 16,
                reason: 'Level 13: open safe mine and find first iron'
            };
        }

        if (level.id === 'L14_COLLECT_RAW_IRON') {
            return {
                action: 'mine_iron',
                count: 17,
                reason: 'Level 14: collect enough raw iron for kit and reserve'
            };
        }

        if (level.id === 'L15_SMELT_IRON') {
            const coreIronDeficit = 17 - smeltedIronPotential(inventory);
            if (
                (inventory.raw_iron || 0) === 0 &&
                coreIronDeficit > 0 &&
                (this.progress.maxIronPotential < 17 || coreIronDeficit > 1)
            ) {
                return {
                    action: 'mine_iron',
                    count: Math.max(1, coreIronDeficit),
                    reason: 'Level 15: replace missing iron before finishing the reserve'
                };
            }
            return {
                action: 'smelt_item',
                input: 'raw_iron',
                output: 'iron_ingot',
                count: Math.max(1, Math.min(8, coreIronDeficit)),
                reason: 'Level 15: smelt raw iron into ingots'
            };
        }

        if (level.id === 'L16_CRAFT_IRON_KIT') {
            return {
                action: 'craft_iron_kit',
                reason: 'Level 16: craft iron tools and shield while preserving reserve'
            };
        }

        if (level.id === 'L17_ESTABLISH_WHEAT_FARM') {
            return {
                action: 'establish_wheat_farm',
                reason: 'Level 17: establish a hydrated wheat farm'
            };
        }

        if (level.id === 'L18_COLLECT_ARMOR_IRON') {
            return {
                action: 'mine_iron',
                count: Math.max(1, FULL_IRON_TARGET - smeltedIronPotential(inventory)),
                reason: 'Level 18: collect additional raw iron for full armor'
            };
        }

        if (level.id === 'L19_SMELT_ARMOR_IRON') {
            const armorIronDeficit = FULL_IRON_TARGET - smeltedIronPotential(inventory);
            if (
                (inventory.raw_iron || 0) === 0 &&
                armorIronDeficit > 0 &&
                (this.progress.maxIronPotential < FULL_IRON_TARGET || armorIronDeficit > 1)
            ) {
                return {
                    action: 'mine_iron',
                    count: Math.max(1, armorIronDeficit),
                    reason: 'Level 19: replace missing armor iron before smelting'
                };
            }
            return {
                action: 'smelt_item',
                input: 'raw_iron',
                output: 'iron_ingot',
                count: Math.max(1, Math.min(8, armorIronDeficit)),
                reason: 'Level 19: smelt iron for full armor'
            };
        }

        if (level.id === 'L20_CRAFT_IRON_ARMOR') {
            return {
                action: 'craft_iron_armor',
                reason: 'Level 20: craft and equip full iron armor'
            };
        }

        if (level.id === 'L21_STABLE_SURVIVAL') {
            if (!iron.hasIronCoreKit(inventory)) {
                return {
                    action: 'prepare_mining_kit',
                    reason: 'Routine: advance toward iron age'
                };
            }

            if (!food.hasFoodStock(inventory, 16) && !food.isTemporarilyUnavailable()) {
                return {
                    action: observation.farmReady ? 'maintain_food_supply' : 'find_food',
                    reason: observation.farmReady
                        ? 'Routine: maintain the base food farm'
                        : 'Routine: food reserve is low'
                };
            }

            if (totalPlanks(inventory) < 12 && totalLogs(inventory) > 0) {
                const logName = LOG_ITEMS.find(name => (inventory[name] || 0) > 0);
                return {
                    action: 'craft',
                    item: plankForLog(logName || 'oak_log'),
                    count: Math.max(4, 12 - totalPlanks(inventory)),
                    reason: 'Routine: refill plank reserve'
                };
            }

            if (woodUnits(inventory) < 2) {
                const visibleLog = nearestVisibleLog(observation);
                if (visibleLog) {
                    return {
                        action: 'mine',
                        target: 'any_log',
                        reason: `Routine: refill wood reserve (${visibleLog.name} observed)`
                    };
                }
                return {
                    action: 'mine',
                    target: 'any_log',
                    reason: 'Routine: find and cut a reachable tree'
                };
            }

            if (shouldOrganizeInventory(inventory, observation)) {
                return {
                    action: 'organize_storage',
                    reason: 'Routine: organize inventory into chest'
                };
            }

            return {
                action: 'idle',
                ms: 3000,
                reason: 'Routine: core supplies are stable, wait safely'
            };
        }

        return null;
    }

    validateAction(action, level) {
        if (!action || typeof action !== 'object') return null;
        if (!level.allowedActions.includes(action.action)) return null;

        if (action.action === 'mine' && typeof action.target === 'string') return action;
        if (action.action === 'explore') return action;
        if (action.action === 'idle') return action;
        if (action.action === 'collect_stone') return action;
        if (action.action === 'craft_stone_tools') return action;
        if (action.action === 'build_shelter') return action;
        if (action.action === 'eat_food') return action;
        if (action.action === 'find_food') return action;
        if (action.action === 'maintain_food_supply') return action;
        if (action.action === 'fight_mob') return action;
        if (action.action === 'evade_hostile') return action;
        if (action.action === 'emergency_shelter') return action;
        if (action.action === 'escape_pit') return action;
        if (action.action === 'escape_water') return action;
        if (action.action === 'return_base') return action;
        if (action.action === 'organize_storage') return action;
        if (action.action === 'secure_bed') return action;
        if (action.action === 'establish_wheat_farm') return action;
        if (action.action === 'prepare_mining_kit') return action;
        if (action.action === 'mine_iron') return action;
        if (action.action === 'smelt_item') return action;
        if (action.action === 'craft_iron_kit') return action;
        if (action.action === 'craft_iron_armor') return action;
        if (action.action === 'craft' && typeof action.item === 'string') return action;
        if (action.action === 'place' && typeof action.item === 'string') return action;

        return null;
    }

    fallbackAction(observation, level) {
        return this.getForcedAction(observation, level) || {
            action: 'idle',
            ms: 1000,
            reason: 'No valid action available'
        };
    }

    updateProgress(observation) {
        if (!hasProgressionInventory(observation.inventory)) {
            this.progress.maxWoodUnits = 0;
            this.progress.maxPlanks = 0;
            this.progress.maxCobblestone = 0;
            this.progress.maxIronPotential = 0;
            memory.setProgress('maxWoodUnits', 0);
            memory.setProgress('maxPlanks', 0);
            memory.setProgress('maxCobblestone', 0);
            memory.setProgress('maxIronPotential', 0);
            this.progress.hasCraftingTable = false;
            memory.setProgress('hasCraftingTable', 0);
            return;
        }

        this.progress.maxWoodUnits = Math.max(
            this.progress.maxWoodUnits,
            woodUnits(observation.inventory)
        );
        this.progress.maxPlanks = Math.max(
            this.progress.maxPlanks,
            totalPlanks(observation.inventory)
        );
        this.progress.maxCobblestone = Math.max(
            this.progress.maxCobblestone,
            observation.inventory.cobblestone || 0
        );
        this.progress.maxIronPotential = Math.max(
            this.progress.maxIronPotential,
            rawIronPotential(observation.inventory)
        );
        memory.setProgress('maxWoodUnits', this.progress.maxWoodUnits);
        memory.setProgress('maxPlanks', this.progress.maxPlanks);
        memory.setProgress('maxCobblestone', this.progress.maxCobblestone);
        memory.setProgress('maxIronPotential', this.progress.maxIronPotential);
        if (
            observation.nearbyBlocks.some(block => block.name === 'crafting_table' && block.distance <= 16)
        ) {
            this.progress.hasCraftingTable = true;
        }
        if (observation.hasPlacedCraftingTable === true) {
            this.progress.hasCraftingTable = true;
        }
        if (this.progress.hasCraftingTable) memory.setProgress('hasCraftingTable', 1);
    }
}

function hasProgressionInventory(inventory) {
    if (woodUnits(inventory) > 0) return true;
    return Object.entries(inventory).some(([name, count]) => count > 0 && (
        name === 'cobblestone' ||
        name === 'raw_iron' ||
        name === 'iron_ingot' ||
        name.endsWith('_pickaxe') ||
        name.endsWith('_axe') ||
        name.endsWith('_sword') ||
        name.endsWith('_helmet') ||
        name.endsWith('_chestplate') ||
        name.endsWith('_leggings') ||
        name.endsWith('_boots')
    ));
}

function nearestVisibleLog(observation) {
    return observation.nearbyBlocks.find(block => LOG_ITEMS.includes(block.name));
}

function totalLogs(inventory) {
    return LOG_ITEMS.reduce((sum, name) => sum + (inventory[name] || 0), 0);
}

function woodUnits(inventory) {
    return totalLogs(inventory) +
        totalPlanks(inventory) / 4 +
        (inventory.stick || 0) / 8 +
        (inventory.crafting_table || 0) +
        (inventory.wooden_pickaxe || 0);
}

function totalPlanks(inventory) {
    return Object.entries(inventory)
        .filter(([name]) => name.endsWith('_planks'))
        .reduce((sum, [, count]) => sum + count, 0);
}

function shelterBuildBlocks(inventory) {
    return (inventory.cobblestone || 0) +
        (inventory.dirt || 0) +
        totalPlanks(inventory);
}

function plankForLog(logName) {
    return logName.replace(/_log$/, '_planks');
}

function hasStoneTools(inventory) {
    return ['stone_pickaxe', 'stone_axe', 'stone_sword']
        .every(name => (inventory[name] || 0) >= 1);
}

function hasCraftedWoodProgress(inventory) {
    return totalPlanks(inventory) > 0 ||
        (inventory.crafting_table || 0) > 0 ||
        hasPickaxeProgress(inventory);
}

function hasPickaxeProgress(inventory) {
    return ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
        .some(name => (inventory[name] || 0) > 0);
}

function hasUpgradedPickaxe(inventory) {
    return ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
        .some(name => (inventory[name] || 0) > 0);
}

function foodScore(inventory) {
    return food.foodScore(inventory);
}

function hasMiningKit(observation) {
    const inventory = observation.inventory;
    if (iron.hasIronCoreKit(inventory)) return true;
    if (rawIronPotential(inventory) > 0) return true;
    return assessMiningKit(observation).ready;
}

function rawIronPotential(inventory) {
    return (inventory.raw_iron || 0) +
        (inventory.iron_ingot || 0) +
        iron.ironInvestment(inventory);
}

function smeltedIronPotential(inventory) {
    return (inventory.iron_ingot || 0) + iron.ironInvestment(inventory);
}

function hasIronInFurnaceTransition(inventory) {
    return (inventory.raw_iron || 0) > 0 &&
        (inventory.iron_ingot || 0) > 0 &&
        rawIronPotential(inventory) >= 16;
}

function shouldOrganizeInventory(inventory, observation) {
    if (observation.hasUsableChest !== true) return false;
    if (observation.storageReady === false) return false;
    return storage.hasDepositableItems(inventory);
}

module.exports = SkillTree;
