const {
    inventoryCount,
    isSafeFoodItem,
    safeFoodInventoryCount
} = require('./utils');

class GoalPlanner {
    constructor(bot, options = {}) {
        this.bot = bot;
        this.maxDepth = options.maxDepth || 12;
        this.memory = options.memory || null;
    }

    validateGoal(goal) {
        if (!goal || typeof goal !== 'object') return null;

        if (goal.type === 'explore') {
            return {
                type: 'explore',
                reason: String(goal.reason || 'Yeni kaynaklar bul')
            };
        }

        if (goal.type === 'find_food') {
            return {
                type: 'find_food',
                count: Math.max(1, Math.min(64, Number(goal.count) || 1)),
                reason: String(goal.reason || 'Yiyecek bul')
            };
        }

        if (goal.type === 'idle') {
            return {
                type: 'idle',
                until: Number(goal.until) || Date.now() + 30000,
                reason: String(goal.reason || 'Kisa sure bekle')
            };
        }

        if (goal.type === 'build_shelter') {
            return {
                type: 'build_shelter',
                reason: String(goal.reason || 'Guvenli bir ilk barinak kur')
            };
        }

        if (goal.type === 'emergency_shelter') {
            return {
                type: 'emergency_shelter',
                reason: String(goal.reason || 'Gecici toprak siper kur')
            };
        }

        if (goal.type === 'build_farm') {
            return {
                type: 'build_farm',
                dry: Boolean(goal.dry),
                reason: String(goal.reason || 'Bugday tarlasi kur')
            };
        }

        if (['establish_mine', 'upgrade_base',
            'equip_iron_armor', 'build_house', 'organize_storage',
            'expand_farm', 'establish_tree_garden',
            'maintain_tree_garden', 'establish_deep_mine',
            'equip_diamond_armor', 'build_nether_portal',
            'enter_nether', 'place_bed', 'prepare_loadout',
            'survive_night', 'recover_items'].includes(goal.type)) {
            return {
                type: goal.type,
                reason: String(goal.reason || goal.type)
            };
        }

        if (goal.type !== 'acquire_item') return null;
        if (typeof goal.item !== 'string') return null;
        if (!this.bot.registry.itemsByName[goal.item]) return null;

        return {
            type: 'acquire_item',
            item: goal.item,
            count: Math.max(1, Math.min(64, Number(goal.count) || 1)),
            reason: String(goal.reason || `${goal.item} edin`)
        };
    }

    isGoalComplete(goal, observation = null) {
        if (goal.type === 'explore') return false;
        if (goal.type === 'idle') return Date.now() >= (goal.until || 0);
        if (goal.type === 'find_food') {
            const hasSafeFood = this.bot.inventory.items().some(item =>
                isSafeFoodItem(this.bot, item)
            );
            if ((goal.count || 1) > 1) {
                return safeFoodInventoryCount(this.bot) >= goal.count;
            }
            if (observation?.health >= 14 && observation?.food >= 8) return true;
            if (observation?.health < 14 && !hasSafeFood) return false;
            if (observation?.food >= 12) return true;
            return hasSafeFood;
        }
        if (goal.type === 'build_shelter') {
            return Boolean(this.memory?.data.shelter);
        }
        if (goal.type === 'emergency_shelter') {
            return Boolean(this.memory?.data.shelter);
        }
        if (goal.type === 'survive_night') {
            return observation && !observation.isNight;
        }
        if (goal.type === 'recover_items') {
            return !this.memory?.data.deathPosition;
        }
        if (goal.type === 'place_bed') {
            return (this.memory?.data.beds?.length || 0) > 0;
        }
        if (goal.type === 'prepare_loadout') return false;
        if (goal.type === 'establish_mine') {
            return Boolean(this.memory?.data.mine);
        }
        if (goal.type === 'build_farm') {
            return Boolean(this.memory?.data.farm);
        }
        if (goal.type === 'upgrade_base') {
            return Boolean(this.memory?.data.upgradedBase);
        }
        if (goal.type === 'equip_iron_armor') {
            return Boolean(this.memory?.data.ironArmorEquipped);
        }
        if (goal.type === 'build_house') {
            return Boolean(this.memory?.data.beautifulHouse);
        }
        if (goal.type === 'organize_storage') {
            return Boolean(this.memory?.data.storageSystem);
        }
        if (goal.type === 'expand_farm') {
            return Boolean(this.memory?.data.expandedFarm);
        }
        if (goal.type === 'establish_tree_garden') {
            return Boolean(this.memory?.data.treeGarden);
        }
        if (goal.type === 'maintain_tree_garden') return false;
        if (goal.type === 'establish_deep_mine') {
            return Boolean(this.memory?.data.deepMine);
        }
        if (goal.type === 'equip_diamond_armor') {
            return Boolean(this.memory?.data.diamondArmorEquipped);
        }
        if (goal.type === 'build_nether_portal') {
            return Boolean(this.memory?.data.netherPortal);
        }
        if (goal.type === 'enter_nether') {
            return Boolean(this.memory?.data.enteredNether);
        }
        if (goal.type === 'acquire_item' && goal.item.endsWith('_bed')) {
            const nearbyBed = this.bot.findBlock({
                matching: block => this.bot.isABed(block),
                maxDistance: 24
            });
            if (nearbyBed) return true;
        }
        return inventoryCount(this.bot, goal.item) >= goal.count;
    }

    plan(goal, observation) {
        if (goal.type === 'explore') {
            return { type: 'explore', reason: goal.reason };
        }

        if (goal.type === 'idle') {
            return {
                type: 'idle',
                until: goal.until,
                reason: goal.reason
            };
        }

        if (goal.type === 'find_food') {
            return {
                type: 'hunt_food',
                count: goal.count,
                reason: goal.reason
            };
        }

        if (goal.type === 'build_shelter') {
            return this.planBuildShelter(goal, observation);
        }
        if (goal.type === 'emergency_shelter') {
            return {
                type: 'emergency_shelter',
                reason: goal.reason
            };
        }
        if (goal.type === 'survive_night') {
            return {
                type: 'survive_night',
                reason: goal.reason
            };
        }
        if (goal.type === 'recover_items') {
            return {
                type: 'recover_items',
                reason: goal.reason
            };
        }
        if (goal.type === 'place_bed') {
            return this.planPlaceBed(goal, observation);
        }
        if (goal.type === 'prepare_loadout') {
            return {
                type: 'prepare_loadout',
                reason: goal.reason
            };
        }

        if (goal.type === 'establish_mine') {
            return this.planEstablishMine(goal, observation);
        }
        if (goal.type === 'build_farm') {
            return this.planBuildFarm(goal, observation);
        }
        if (goal.type === 'upgrade_base') {
            return this.planUpgradeBase(goal, observation);
        }
        if (goal.type === 'equip_iron_armor') {
            return this.planEquipArmor(goal, observation, 'iron');
        }
        if (goal.type === 'build_house') {
            return this.planBuildHouse(goal, observation);
        }
        if (goal.type === 'organize_storage') {
            return this.planOrganizeStorage(goal, observation);
        }
        if (goal.type === 'expand_farm') {
            return this.planExpandFarm(goal, observation);
        }
        if (goal.type === 'establish_tree_garden') {
            return this.planTreeGarden(goal, observation);
        }
        if (goal.type === 'maintain_tree_garden') {
            return { type: 'maintain_tree_garden', reason: goal.reason };
        }
        if (goal.type === 'establish_deep_mine') {
            return this.planDeepMine(goal, observation);
        }
        if (goal.type === 'equip_diamond_armor') {
            return this.planEquipArmor(goal, observation, 'diamond');
        }
        if (goal.type === 'build_nether_portal') {
            return { type: 'build_nether_portal', reason: goal.reason };
        }
        if (goal.type === 'enter_nether') {
            return { type: 'enter_nether', reason: goal.reason };
        }

        return this.planAcquire(
            goal.item,
            goal.count,
            observation,
            0,
            new Set()
        );
    }

    planBuildShelter(goal, observation) {
        if (inventoryCount(this.bot, 'cobblestone') < 24) {
            return this.planAcquire('cobblestone', 24, observation, 0, new Set());
        }
        return { type: 'build_shelter', reason: goal.reason };
    }

    planPlaceBed(goal, observation) {
        const carriedBed = this.bot.inventory.items()
            .some(item => item.name.endsWith('_bed'));
        if (!carriedBed) {
            return this.planAcquire('white_bed', 1, observation, 0, new Set());
        }
        return { type: 'place_bed', reason: goal.reason };
    }

    planEstablishMine(goal, observation) {
        if (!this.memory?.data.base && !this.memory?.data.shelter) {
            return this.planBuildShelter({
                type: 'build_shelter',
                reason: 'Maden icin once guvenli bir ana us gerekli'
            }, observation);
        }
        if (!this.hasToolAtLeast('pickaxe', 'stone')) {
            return this.planAcquire('stone_pickaxe', 1, observation, 0, new Set());
        }
        return { type: 'establish_mine', reason: goal.reason };
    }

    planBuildFarm(goal, observation) {
        const dryFarm = Boolean(goal.dry || this.memory?.data.waterUnavailable);
        const planted = this.memory?.data.farmInProgress?.planted || 0;
        const seedTarget = planted > 0 ? Math.max(0, 8 - planted) : 8;
        if (
            seedTarget > 0 &&
            inventoryCount(this.bot, 'wheat_seeds') < seedTarget
        ) {
            return this.planAcquire('wheat_seeds', seedTarget, observation, 0, new Set());
        }
        if (!this.hasToolAtLeast('hoe', 'stone')) {
            return this.planAcquire('stone_hoe', 1, observation, 0, new Set());
        }
        if (
            !dryFarm &&
            inventoryCount(this.bot, 'water_bucket') < 1
        ) {
            return this.planAcquire('water_bucket', 1, observation, 0, new Set());
        }
        return { type: 'build_farm', dry: dryFarm, reason: goal.reason };
    }

    planUpgradeBase(goal, observation) {
        if (inventoryCount(this.bot, 'oak_planks') < 24) {
            return this.planAcquire('oak_planks', 24, observation, 0, new Set());
        }
        return { type: 'upgrade_base', reason: goal.reason };
    }

    planBuildHouse(goal, observation) {
        const needs = this.houseMaterialNeeds();
        if (inventoryCount(this.bot, 'oak_planks') < needs.oak_planks) {
            return this.planAcquire('oak_planks', needs.oak_planks, observation, 0, new Set());
        }
        if (inventoryCount(this.bot, 'cobblestone') < needs.cobblestone) {
            return this.planAcquire('cobblestone', needs.cobblestone, observation, 0, new Set());
        }
        return { type: 'build_house', reason: goal.reason };
    }

    planOrganizeStorage(goal, observation) {
        if (inventoryCount(this.bot, 'chest') < 3) {
            return this.planAcquire('chest', 4, observation, 0, new Set());
        }
        return { type: 'organize_storage', reason: goal.reason };
    }

    planExpandFarm(goal, observation) {
        const planted = this.memory?.data.farm?.cropCount || 8;
        const neededSeeds = Math.max(0, 24 - planted);
        if (inventoryCount(this.bot, 'wheat_seeds') < neededSeeds) {
            return this.planAcquire('wheat_seeds', neededSeeds, observation, 0, new Set());
        }
        return { type: 'expand_farm', reason: goal.reason };
    }

    planTreeGarden(goal, observation) {
        if (inventoryCount(this.bot, 'oak_sapling') < 3) {
            return this.planAcquire('oak_sapling', 3, observation, 0, new Set());
        }
        return { type: 'establish_tree_garden', reason: goal.reason };
    }

    planDeepMine(goal, observation) {
        if (inventoryCount(this.bot, 'torch') < 16) {
            return this.planAcquire('torch', 16, observation, 0, new Set());
        }
        if (!this.hasToolAtLeast('pickaxe', 'iron')) {
            return this.planAcquire('iron_pickaxe', 1, observation, 0, new Set());
        }
        return { type: 'establish_deep_mine', reason: goal.reason };
    }

    planEquipArmor(goal, observation, material) {
        for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
            const itemName = `${material}_${piece}`;
            if (inventoryCount(this.bot, itemName) < 1) {
                return this.planAcquire(itemName, 1, observation, 0, new Set());
            }
        }
        return { type: goal.type, reason: goal.reason };
    }

    houseMaterialNeeds() {
        return { oak_planks: 108, cobblestone: 72 };
    }

    hasToolAtLeast(toolType, tier) {
        const tiers = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'];
        const minRank = tiers.indexOf(tier);
        return this.bot.inventory.items().some(item => {
            const match = item.name.match(
                /^(wooden|stone|golden|iron|diamond|netherite)_(pickaxe|axe|sword|hoe|shovel)$/
            );
            return match &&
                match[2] === toolType &&
                tiers.indexOf(match[1]) >= minRank;
        });
    }

    planAcquire(itemName, desiredCount, observation, depth, visited) {
        if (depth > this.maxDepth) {
            return { type: 'blocked', reason: `Plan derinligi asildi: ${itemName}` };
        }

        const item = this.bot.registry.itemsByName[itemName];
        if (!item) {
            return { type: 'blocked', reason: `Bilinmeyen item: ${itemName}` };
        }

        const currentCount = inventoryCount(this.bot, itemName);
        if (currentCount >= desiredCount) {
            return { type: 'complete', item: itemName };
        }

        if (itemName === 'torch') {
            return this.planTorch(desiredCount, currentCount, observation, depth, visited);
        }

        if (itemName.endsWith('_wool')) {
            return this.planGather(
                item,
                desiredCount - currentCount,
                observation,
                depth,
                visited
            );
        }

        if (['raw_iron', 'raw_copper', 'raw_gold'].includes(itemName)) {
            return this.planGather(
                item,
                desiredCount - currentCount,
                observation,
                depth,
                visited
            );
        }

        if (itemName === 'coal') {
            return this.planGather(
                item,
                desiredCount - currentCount,
                observation,
                depth,
                visited
            );
        }

        if (itemName === 'iron_ingot') {
            const rawCount = inventoryCount(this.bot, 'raw_iron');
            if (rawCount < desiredCount - currentCount) {
                return this.planAcquire(
                    'raw_iron',
                    desiredCount - currentCount,
                    observation,
                    depth + 1,
                    visited
                );
            }
            const fuelPlan = this.planStableSmeltingFuel(
                desiredCount - currentCount,
                observation,
                depth,
                visited
            );
            if (fuelPlan) return fuelPlan;
            return {
                type: 'smelt',
                input: 'raw_iron',
                output: 'iron_ingot',
                count: desiredCount - currentCount
            };
        }

        if (itemName === 'charcoal') {
            const required = desiredCount - currentCount;
            const logs = this.bot.inventory.items()
                .filter(entry => this.isWoodLogItem(entry.name));
            const logCount = logs.reduce((total, entry) => total + entry.count, 0);
            if (logCount < required) {
                return this.planAcquire(
                    'oak_log',
                    required - logCount,
                    observation,
                    depth + 1,
                    visited
                );
            }
            const fuelPlan = this.planStableSmeltingFuel(
                required,
                observation,
                depth,
                visited
            );
            if (fuelPlan) return fuelPlan;
            return {
                type: 'smelt',
                input: logs[0].name,
                output: 'charcoal',
                count: required
            };
        }

        if (itemName === 'water_bucket') {
            if (inventoryCount(this.bot, 'bucket') < 1) {
                return this.planAcquire(
                    'bucket',
                    1,
                    observation,
                    depth + 1,
                    visited
                );
            }
            return { type: 'fill_bucket', fluid: 'water' };
        }

        if (itemName === 'wheat_seeds') {
            return {
                type: 'gather_seeds',
                count: desiredCount
            };
        }
        if (itemName === 'oak_sapling') {
            return {
                type: 'gather_saplings',
                count: desiredCount
            };
        }
        if (itemName === 'diamond') {
            return this.planGather(
                item,
                desiredCount - currentCount,
                observation,
                depth,
                visited
            );
        }

        if (/^wooden_(pickaxe|axe|sword|hoe|shovel)$/.test(itemName)) {
            return this.planWoodenTool(itemName, desiredCount, observation, depth, visited);
        }

        const visitKey = `${itemName}:${desiredCount}`;
        if (visited.has(visitKey)) {
            return { type: 'blocked', reason: `Tarif dongusu: ${itemName}` };
        }

        const nextVisited = new Set(visited);
        nextVisited.add(visitKey);

        const recipes = this.rankRecipes(
            this.bot.recipesAll(item.id, null, true),
            observation
        );

        for (const recipe of recipes) {
            const craftCount = Math.ceil(
                (desiredCount - currentCount) / recipe.result.count
            );
            const missingIngredients = recipe.delta
                .filter(delta => delta.count < 0)
                .map(delta => ({
                    id: delta.id,
                    metadata: delta.metadata,
                    count: Math.abs(delta.count) * craftCount
                }))
                .filter(ingredient =>
                    this.bot.inventory.count(ingredient.id, ingredient.metadata) < ingredient.count
                );

            let ingredientPlan = null;
            for (const ingredient of missingIngredients) {
                const ingredientItem = this.bot.registry.items[ingredient.id];
                if (!ingredientItem) continue;

                ingredientPlan = this.planAcquire(
                    ingredientItem.name,
                    ingredient.count,
                    observation,
                    depth + 1,
                    nextVisited
                );

                if (ingredientPlan.type !== 'blocked') break;
            }

            if (ingredientPlan && ingredientPlan.type !== 'complete') {
                return ingredientPlan;
            }

            if (missingIngredients.length > 0 && !ingredientPlan) {
                continue;
            }

            if (recipe.requiresTable) {
                const table = this.findNearbyCraftingTable();
                if (!table) {
                    if (this.hasKnownCraftingTable()) {
                        return {
                            type: 'return_workstation',
                            workstation: 'crafting_table',
                            reason: `${itemName} icin mevcut crafting table'a don`
                        };
                    }

                    if (inventoryCount(this.bot, 'crafting_table') > 0) {
                        return {
                            type: 'place_workstation',
                            workstation: 'crafting_table'
                        };
                    }

                    return this.planAcquire(
                        'crafting_table',
                        1,
                        observation,
                        depth + 1,
                        nextVisited
                    );
                }
            }

            return {
                type: 'craft',
                item: itemName,
                count: desiredCount - currentCount,
                requiresTable: recipe.requiresTable
            };
        }

        return this.planGather(item, desiredCount - currentCount, observation, depth, nextVisited);
    }

    planWoodenTool(itemName, desiredCount, observation, depth, visited) {
        const currentCount = inventoryCount(this.bot, itemName);
        if (currentCount >= desiredCount) {
            return { type: 'complete', item: itemName };
        }

        const toolType = itemName.replace('wooden_', '');
        const requirements = {
            pickaxe: { planks: 3, sticks: 2 },
            axe: { planks: 3, sticks: 2 },
            sword: { planks: 2, sticks: 1 },
            hoe: { planks: 2, sticks: 2 },
            shovel: { planks: 1, sticks: 2 }
        }[toolType];
        if (!requirements) {
            return { type: 'blocked', reason: `Bilinmeyen ahsap alet: ${itemName}` };
        }

        const plankCount = this.inventoryCountByNameSuffix('_planks');
        if (plankCount < requirements.planks) {
            const log = this.bot.inventory.items()
                .find(entry => this.isWoodLogItem(entry.name));
            if (log) {
                const planks = this.planksForLog(log.name);
                if (planks) {
                    return {
                        type: 'craft',
                        item: planks,
                        count: requirements.planks - plankCount,
                        requiresTable: false
                    };
                }
            }
            return this.planAcquire(
                'oak_log',
                Math.ceil((requirements.planks - plankCount) / 4),
                observation,
                depth + 1,
                visited
            );
        }

        if (inventoryCount(this.bot, 'stick') < requirements.sticks) {
            return this.planAcquire(
                'stick',
                requirements.sticks,
                observation,
                depth + 1,
                visited
            );
        }

        const table = this.findNearbyCraftingTable();
        if (!table) {
            if (this.hasKnownCraftingTable()) {
                return {
                    type: 'return_workstation',
                    workstation: 'crafting_table',
                    reason: `${itemName} icin mevcut crafting table'a don`
                };
            }

            if (inventoryCount(this.bot, 'crafting_table') > 0) {
                return {
                    type: 'place_workstation',
                    workstation: 'crafting_table'
                };
            }

            return this.planAcquire(
                'crafting_table',
                1,
                observation,
                depth + 1,
                visited
            );
        }

        return {
            type: 'craft',
            item: itemName,
            count: desiredCount - currentCount,
            requiresTable: true
        };
    }

    inventoryCountByNameSuffix(suffix) {
        return this.bot.inventory.items()
            .filter(item => item.name.endsWith(suffix))
            .reduce((total, item) => total + item.count, 0);
    }

    planksForLog(logName) {
        const prefixes = [
            'oak',
            'spruce',
            'birch',
            'jungle',
            'acacia',
            'dark_oak',
            'mangrove',
            'cherry'
        ];
        const prefix = prefixes.find(name =>
            logName === `${name}_log` || logName === `${name}_wood`
        );
        return prefix ? `${prefix}_planks` : null;
    }

    planTorch(desiredCount, currentCount, observation, depth, visited) {
        const missingTorches = desiredCount - currentCount;
        const craftsNeeded = Math.ceil(missingTorches / 4);
        const stickCount = inventoryCount(this.bot, 'stick');
        if (stickCount < craftsNeeded) {
            return this.planAcquire(
                'stick',
                craftsNeeded,
                observation,
                depth + 1,
                visited
            );
        }

        const coalCount = inventoryCount(this.bot, 'coal');
        const charcoalCount = inventoryCount(this.bot, 'charcoal');
        if (coalCount + charcoalCount < craftsNeeded) {
            return this.planAcquire(
                'charcoal',
                craftsNeeded - coalCount - charcoalCount,
                observation,
                depth + 1,
                visited
            );
        }

        return {
            type: 'craft',
            item: 'torch',
            count: missingTorches,
            requiresTable: false
        };
    }

    planStableSmeltingFuel(requiredSmelts, observation, depth, visited) {
        const required = Math.max(1, requiredSmelts);
        if (this.stableSmeltingFuelCapacity() >= required) return null;

        const currentPlanks = [
            'oak_planks',
            'spruce_planks',
            'birch_planks'
        ].reduce((total, name) => total + inventoryCount(this.bot, name), 0);
        const neededPlanks = Math.max(currentPlanks + 1, Math.ceil(required / 1.5));

        if (this.hasWoodLog()) {
            return this.planAcquire(
                'oak_planks',
                neededPlanks,
                observation,
                depth + 1,
                visited
            );
        }
        return this.planAcquire(
            'oak_log',
            1,
            observation,
            depth + 1,
            visited
        );
    }

    stableSmeltingFuelCapacity() {
        const coalLike =
            inventoryCount(this.bot, 'coal') +
            inventoryCount(this.bot, 'charcoal');
        const planks = [
            'oak_planks',
            'spruce_planks',
            'birch_planks'
        ].reduce((total, name) => total + inventoryCount(this.bot, name), 0);
        return coalLike * 8 + Math.floor(planks * 1.5);
    }

    hasWoodLog() {
        return this.bot.inventory.items().some(item => this.isWoodLogItem(item.name));
    }

    planGather(item, count, observation, depth, visited) {
        if (item.name.endsWith('_wool')) {
            const sheep = observation.nearbyMobs.find(mob => mob.name === 'sheep');
            return sheep
                ? {
                    type: 'hunt_mob',
                    mob: 'sheep',
                    item: item.name,
                    count
                }
                : {
                    type: 'explore',
                    resource: 'sheep',
                    reason: 'Yatak icin koyun ara'
                };
        }

        const blocks = this.gatherBlocksForItem(item);

        if (blocks.length === 0) {
            return {
                type: 'blocked',
                reason: `${item.name} icin crafting veya block drop yolu bulunamadi`
            };
        }

        const visibleNames = new Set(observation.nearbyBlocks.map(block => block.name));
        const visibleCandidates = blocks
            .filter(block => visibleNames.has(block.name));
        const visibleBlock = this.chooseVisibleGatherBlock(
            item.name,
            visibleCandidates,
            observation
        );

        if (!visibleBlock) {
            if (item.name === 'obsidian') {
                const toolPlan = this.planRequiredTool(
                    this.bot.registry.blocksByName.obsidian,
                    observation,
                    depth,
                    visited
                );
                if (toolPlan) return toolPlan;

                return {
                    type: 'mine_tunnel',
                    resource: 'obsidian',
                    candidates: ['obsidian'],
                    reason: 'Nether portali icin obsidian ara'
                };
            }

            const undergroundBlock = blocks.find(block =>
                block.name === 'stone' || block.name === 'deepslate'
            );

            if (undergroundBlock) {
                const toolPlan = this.planRequiredTool(
                    undergroundBlock,
                    observation,
                    depth,
                    visited
                );
                if (toolPlan) return toolPlan;

                return {
                    type: 'dig_staircase',
                    resource: item.name,
                    reason: `${item.name} yuzeyde gorunmuyor; guvenli maden girisi ac`
                };
            }

            const undergroundOre = blocks.find(block =>
                block.name.endsWith('_ore')
            );
            if (undergroundOre) {
                const toolPlan = this.planRequiredTool(
                    undergroundOre,
                    observation,
                    depth,
                    visited
                );
                if (toolPlan) return toolPlan;

                return {
                    type: 'mine_tunnel',
                    resource: item.name,
                    candidates: blocks.map(block => block.name),
                    reason: `${item.name} icin guvenli maden kolu ac`
                };
            }

            const genericResource = this.isWoodLogItem(item.name)
                ? 'herhangi_bir_odun'
                : item.name;
            return {
                type: 'explore',
                resource: genericResource,
                candidates: blocks.slice(0, 12).map(block => block.name),
                reason: `${genericResource} kaynagi ara`
            };
        }

        const toolPlan = this.planRequiredTool(visibleBlock, observation, depth, visited);
        if (toolPlan) return toolPlan;

        return {
            type: 'mine',
            block: visibleBlock.name,
            item: this.primaryDropName(visibleBlock) || item.name,
            count
        };
    }

    chooseVisibleGatherBlock(itemName, blocks, observation) {
        if (blocks.length === 0) return null;

        const distance = block => this.blockDistance(block.name, observation);

        if (itemName === 'cobblestone') {
            const naturalStone = blocks
                .filter(block => ['stone', 'deepslate'].includes(block.name))
                .sort((a, b) => distance(a) - distance(b))[0];
            if (naturalStone) return naturalStone;

            const closeCobble = blocks
                .filter(block => block.name === 'cobblestone' && distance(block) <= 12)
                .sort((a, b) => distance(a) - distance(b))[0];
            return closeCobble || null;
        }

        return blocks
            .sort((a, b) => distance(a) - distance(b))[0];
    }

    gatherBlocksForItem(item) {
        const allBlocks = Object.values(this.bot.registry.blocksByName);

        if (this.isWoodLogItem(item.name)) {
            return allBlocks.filter(block =>
                (block.drops || []).some(dropId => {
                    const drop = this.bot.registry.items[dropId];
                    return drop && this.isWoodLogItem(drop.name);
                })
            );
        }

        return allBlocks.filter(block =>
            Array.isArray(block.drops) && block.drops.includes(item.id)
        );
    }

    primaryDropName(block) {
        const dropId = block.drops?.[0];
        return dropId ? this.bot.registry.items[dropId]?.name : null;
    }

    isWoodLogItem(name) {
        return name.endsWith('_log') ||
            name.endsWith('_wood') ||
            name.endsWith('_stem') ||
            name.endsWith('_hyphae') ||
            name === 'bamboo_block';
    }

    planRequiredTool(block, observation, depth, visited) {
        const toolIds = Object.keys(block.harvestTools || {}).map(Number);
        if (toolIds.length === 0) return null;

        const ownedTool = this.bot.inventory.items().find(item => toolIds.includes(item.type));
        if (ownedTool) return null;

        const candidates = toolIds
            .map(id => this.bot.registry.items[id])
            .filter(Boolean)
            .sort((a, b) => this.toolRank(a.name) - this.toolRank(b.name));

        for (const tool of candidates) {
            const plan = this.planAcquire(tool.name, 1, observation, depth + 1, visited);
            if (plan.type !== 'blocked') return plan;
        }

        return {
            type: 'blocked',
            reason: `${block.name} icin uygun alet uretilemiyor`
        };
    }

    rankRecipes(recipes, observation) {
        const visibleDrops = new Set();
        const visibleNames = new Set(observation.nearbyBlocks.map(block => block.name));

        for (const block of Object.values(this.bot.registry.blocksByName)) {
            if (!visibleNames.has(block.name)) continue;
            for (const drop of block.drops || []) visibleDrops.add(drop);
        }

        return [...recipes].sort((a, b) => {
            return this.recipeScore(a, visibleDrops) - this.recipeScore(b, visibleDrops);
        });
    }

    recipeScore(recipe, visibleDrops) {
        let score = recipe.requiresTable ? 2 : 0;

        for (const delta of recipe.delta.filter(entry => entry.count < 0)) {
            const ingredient = this.bot.registry.items[delta.id];
            score += this.materialPreferenceScore(ingredient?.name);
            score += this.ingredientAvailabilityScore(
                delta.id,
                delta.metadata,
                visibleDrops,
                0,
                new Set()
            );
        }

        return score;
    }

    materialPreferenceScore(itemName) {
        if (!itemName) return 0;
        if (itemName.startsWith('oak_')) return 0;
        if (itemName.startsWith('spruce_')) return 1;
        if (itemName.startsWith('birch_')) return 2;
        if (itemName.startsWith('jungle_')) return 3;
        if (itemName.startsWith('acacia_')) return 4;
        if (itemName.startsWith('dark_oak_')) return 5;
        if (itemName.startsWith('mangrove_')) return 6;
        if (itemName.startsWith('cherry_')) return 7;
        if (itemName.startsWith('bamboo_') || itemName === 'bamboo') return 20;
        if (itemName.startsWith('crimson_') || itemName.startsWith('warped_')) return 30;
        return 0;
    }

    ingredientAvailabilityScore(itemId, metadata, visibleDrops, depth, visited) {
        if (this.bot.inventory.count(itemId, metadata) > 0) return -20;
        if (visibleDrops.has(itemId)) return -10;
        if (depth >= 3 || visited.has(itemId)) return 5;

        const nextVisited = new Set(visited);
        nextVisited.add(itemId);
        const recipes = this.bot.recipesAll(itemId, metadata, true);
        if (recipes.length === 0) return 5;

        return Math.min(...recipes.map(recipe => {
            const ingredientScores = recipe.delta
                .filter(entry => entry.count < 0)
                .map(entry => this.ingredientAvailabilityScore(
                    entry.id,
                    entry.metadata,
                    visibleDrops,
                    depth + 1,
                    nextVisited
                ));

            return (recipe.requiresTable ? 2 : 0) +
                ingredientScores.reduce((total, value) => total + value, 0);
        }));
    }

    blockDistance(blockName, observation) {
        return observation.nearbyBlocks.find(block => block.name === blockName)?.distance ?? 999;
    }

    findNearbyCraftingTable() {
        const tableId = this.bot.registry.blocksByName.crafting_table?.id;
        if (!tableId) return null;
        return this.bot.findBlock({ matching: tableId, maxDistance: 6 });
    }

    hasKnownCraftingTable(maxDistance = 48) {
        const visible = this.findNearbyCraftingTable();
        if (visible) return true;

        const knownTables = this.memory?.data.craftingTables || [];
        if (knownTables.length === 0) return false;

        const position = this.bot.entity?.position;
        if (!position) return true;

        return knownTables.some(table =>
            Math.hypot(table.x - position.x, table.z - position.z) <= maxDistance &&
            Math.abs(table.y - position.y) <= 16
        );
    }

    toolRank(name) {
        const tiers = ['wooden_', 'stone_', 'golden_', 'iron_', 'diamond_', 'netherite_'];
        const index = tiers.findIndex(tier => name.startsWith(tier));
        return index === -1 ? 999 : index;
    }
}

module.exports = GoalPlanner;
