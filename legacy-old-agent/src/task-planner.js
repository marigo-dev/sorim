class TaskPlanner {
    constructor(options = {}) {
        this.goalPlanner = options.goalPlanner;
        this.memory = options.memory || null;
    }

    updateContext({ goalPlanner, memory } = {}) {
        if (goalPlanner) this.goalPlanner = goalPlanner;
        if (memory) this.memory = memory;
    }

    createQueue(goal, observation = {}) {
        if (!goal) return [];

        const direct = () => [this.goalTask(goal)];
        const ensureItem = (item, count, reason) =>
            this.goalTask({
                type: 'acquire_item',
                item,
                count,
                reason
            });
        const directGoal = (type, reason, extra = {}) =>
            this.goalTask({
                type,
                reason,
                ...extra
            });

        switch (goal.type) {
            case 'acquire_item':
                return this.acquireQueue(goal, observation);
            case 'build_shelter':
                return [
                    ensureItem('cobblestone', 24, 'Barinak icin blok topla'),
                    directGoal('build_shelter', goal.reason)
                ];
            case 'upgrade_base':
                return [
                    ensureItem('oak_planks', 24, 'Ana us gelistirmesi icin tahta hazirla'),
                    this.actionTask({
                        type: 'return_base',
                        reason: 'Base gelistirmesi ana us yakininda yapilir'
                    }),
                    directGoal('upgrade_base', goal.reason)
                ];
            case 'build_house': {
                const needs = this.goalPlanner?.houseMaterialNeeds?.() ||
                    { oak_planks: 108, cobblestone: 72 };
                return [
                    this.foodReserveTask(),
                    ensureItem('oak_planks', needs.oak_planks, 'Ev icin ahsap malzeme hazirla'),
                    ensureItem('cobblestone', needs.cobblestone, 'Ev icin tas malzeme hazirla'),
                    this.actionTask({
                        type: 'return_base',
                        reason: 'Ev insaati base yakininda yapilir'
                    }),
                    directGoal('build_house', goal.reason)
                ].filter(Boolean);
            }
            case 'build_farm':
                return [
                    ensureItem('wheat_seeds', this.seedTarget(), 'Tarla icin tohum hazirla'),
                    ensureItem('stone_hoe', 1, 'Tarla icin capa hazirla'),
                    this.actionTask({
                        type: 'return_base',
                        reason: 'Tarla base yakininda kurulur'
                    }),
                    directGoal('build_farm', goal.reason, { dry: Boolean(goal.dry) })
                ];
            case 'expand_farm':
                return [
                    ensureItem('wheat_seeds', this.expandSeedTarget(), 'Buyuk tarla icin tohum hazirla'),
                    ensureItem('stone_hoe', 1, 'Tarla buyutmek icin capa hazirla'),
                    this.actionTask({
                        type: 'return_base',
                        reason: 'Tarla buyutme base yakininda yapilir'
                    }),
                    directGoal('expand_farm', goal.reason)
                ];
            case 'organize_storage':
                return [
                    ensureItem('chest', 4, 'Kategorili depo icin sandik hazirla'),
                    this.actionTask({
                        type: 'return_base',
                        reason: 'Depo ana us yakininda kurulur'
                    }),
                    directGoal('organize_storage', goal.reason)
                ];
            case 'establish_mine':
                return [
                    ensureItem('stone_pickaxe', 1, 'Guvenli maden icin tas kazma hazirla'),
                    this.actionTask({
                        type: 'return_base',
                        reason: 'Maden girisi base yakininda acilir'
                    }),
                    directGoal('establish_mine', goal.reason)
                ];
            case 'establish_deep_mine':
                return [
                    this.foodReserveTask(),
                    ensureItem('torch', 16, 'Derin maden icin mesale hazirla'),
                    ensureItem('iron_pickaxe', 1, 'Derin maden icin demir kazma hazirla'),
                    directGoal('establish_deep_mine', goal.reason)
                ].filter(Boolean);
            case 'equip_iron_armor':
                return this.armorTasks('iron', goal.reason);
            case 'equip_diamond_armor':
                return this.armorTasks('diamond', goal.reason);
            case 'prepare_loadout':
                return [
                    this.actionTask({
                        type: 'return_base',
                        reason: 'Loadout duzeni sandiklarin yaninda yapilir'
                    }),
                    directGoal('prepare_loadout', goal.reason)
                ];
            default:
                return direct();
        }
    }

    acquireQueue(goal, observation = {}) {
        if (!goal?.item) return [this.goalTask(goal)];

        const expanded = this.expandAcquire(goal.item, goal.count || 1, observation, new Set());
        if (expanded.length === 0) return [this.goalTask(goal)];

        const finalGoal = this.goalTask(goal);
        const withoutDuplicateFinal = expanded.filter(task =>
            task.kind !== 'goal' ||
            task.goal.type !== 'acquire_item' ||
            task.goal.item !== goal.item
        );
        return [...withoutDuplicateFinal, finalGoal];
    }

    expandAcquire(itemName, count, observation = {}, visited = new Set()) {
        if (this.hasItemOrEquivalent(itemName, count)) return [];
        if (visited.has(itemName)) return [];

        const nextVisited = new Set(visited);
        nextVisited.add(itemName);

        if (/^wooden_(pickaxe|axe|sword|hoe|shovel)$/.test(itemName)) {
            return this.expandWoodenTool(itemName, nextVisited);
        }

        if (/^(stone|iron|diamond)_(pickaxe|axe|sword|hoe|shovel)$/.test(itemName)) {
            return this.expandTieredTool(itemName, nextVisited);
        }

        if (/^(iron|diamond)_(helmet|chestplate|leggings|boots)$/.test(itemName)) {
            return this.expandArmor(itemName, nextVisited);
        }

        if (itemName === 'crafting_table') {
            return [
                ...this.expandAnyPlanks(4, nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: 'crafting_table',
                    count,
                    reason: 'Crafting table yap'
                })
            ];
        }

        if (itemName === 'stick') {
            return [
                ...this.expandAnyPlanks(2, nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: 'stick',
                    count,
                    reason: 'Cubuk yap'
                })
            ];
        }

        if (itemName.endsWith('_planks')) {
            return [
                ...this.expandAnyLogs(Math.ceil(count / 4), nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: itemName,
                    count,
                    reason: `${itemName} yap`
                })
            ];
        }

        if (itemName === 'cobblestone') {
            return [
                ...this.expandAcquire('wooden_pickaxe', 1, observation, nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: 'cobblestone',
                    count,
                    reason: 'Tas kaz'
                })
            ];
        }

        if (['raw_iron', 'coal', 'diamond'].includes(itemName)) {
            const pickaxe = itemName === 'diamond' ? 'iron_pickaxe' : 'stone_pickaxe';
            return [
                ...this.expandAcquire(pickaxe, 1, observation, nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: itemName,
                    count,
                    reason: `${itemName} madeni kaz`
                })
            ];
        }

        if (itemName === 'iron_ingot') {
            return [
                ...this.expandAcquire('raw_iron', count, observation, nextVisited),
                ...this.expandSmeltingSetup(nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: 'iron_ingot',
                    count,
                    reason: 'Demiri erit'
                })
            ];
        }

        if (itemName === 'charcoal') {
            return [
                ...this.expandAnyLogs(count, nextVisited),
                ...this.expandSmeltingSetup(nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: 'charcoal',
                    count,
                    reason: 'Odunu komure cevir'
                })
            ];
        }

        if (itemName === 'torch') {
            const crafts = Math.ceil(count / 4);
            return [
                ...this.expandAcquire('stick', crafts, observation, nextVisited),
                ...this.expandAcquire('charcoal', crafts, observation, nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: 'torch',
                    count,
                    reason: 'Mesale yap'
                })
            ];
        }

        if (itemName === 'chest') {
            return [
                ...this.expandAnyPlanks(8 * count, nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: 'chest',
                    count,
                    reason: 'Sandik yap'
                })
            ];
        }

        if (itemName === 'furnace') {
            return [
                ...this.expandAcquire('cobblestone', 8 * count, observation, nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: 'furnace',
                    count,
                    reason: 'Firin yap'
                })
            ];
        }

        if (itemName === 'bucket') {
            return [
                ...this.expandAcquire('iron_ingot', 3, observation, nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: 'bucket',
                    count,
                    reason: 'Kova yap'
                })
            ];
        }

        if (itemName === 'water_bucket') {
            return [
                ...this.expandAcquire('bucket', 1, observation, nextVisited),
                this.goalTask({
                    type: 'acquire_item',
                    item: 'water_bucket',
                    count,
                    reason: 'Kovaya su doldur'
                })
            ];
        }

        return [this.goalTask({
            type: 'acquire_item',
            item: itemName,
            count,
            reason: `${itemName} edin`
        })];
    }

    expandWoodenTool(itemName, visited) {
        const requirements = {
            pickaxe: { planks: 3, sticks: 2 },
            axe: { planks: 3, sticks: 2 },
            sword: { planks: 2, sticks: 1 },
            hoe: { planks: 2, sticks: 2 },
            shovel: { planks: 1, sticks: 2 }
        };
        const toolType = itemName.replace('wooden_', '');
        const req = requirements[toolType];
        if (!req) return [];
        const tablePlanks = this.hasCraftingTableAccess() ? 0 : 4;
        const totalPlanks = req.planks + this.planksNeededForSticks(req.sticks) + tablePlanks;

        return [
            ...this.expandAnyPlanks(totalPlanks, visited),
            this.goalTask({
                type: 'acquire_item',
                item: 'stick',
                count: req.sticks,
                reason: 'Alet icin cubuk yap'
            }),
            ...this.craftingTableTask(),
            this.goalTask({
                type: 'acquire_item',
                item: itemName,
                count: 1,
                reason: `${itemName} yap`
            })
        ];
    }

    expandTieredTool(itemName, visited) {
        const [tier, toolType] = itemName.split('_');
        const requirements = {
            pickaxe: { material: 3, sticks: 2 },
            axe: { material: 3, sticks: 2 },
            sword: { material: 2, sticks: 1 },
            hoe: { material: 2, sticks: 2 },
            shovel: { material: 1, sticks: 2 }
        }[toolType];
        if (!requirements) return [];

        const material = {
            stone: 'cobblestone',
            iron: 'iron_ingot',
            diamond: 'diamond'
        }[tier];
        if (!material) return [];
        const tablePlanks = this.hasCraftingTableAccess() ? 0 : 4;
        const totalPlanks = this.planksNeededForSticks(requirements.sticks) + tablePlanks;

        return [
            ...this.expandAcquire(material, requirements.material, {}, visited),
            ...this.expandAnyPlanks(totalPlanks, visited),
            this.goalTask({
                type: 'acquire_item',
                item: 'stick',
                count: requirements.sticks,
                reason: 'Alet icin cubuk yap'
            }),
            ...this.craftingTableTask(),
            this.goalTask({
                type: 'acquire_item',
                item: itemName,
                count: 1,
                reason: `${itemName} yap`
            })
        ];
    }

    expandArmor(itemName, visited) {
        const [material, piece] = itemName.split('_');
        const required = {
            helmet: 5,
            chestplate: 8,
            leggings: 7,
            boots: 4
        }[piece];
        const ingredient = material === 'iron' ? 'iron_ingot' : 'diamond';
        return [
            ...this.expandAcquire(ingredient, required, {}, visited),
            ...this.expandAnyPlanks(this.hasCraftingTableAccess() ? 0 : 4, visited),
            ...this.craftingTableTask(),
            this.goalTask({
                type: 'acquire_item',
                item: itemName,
                count: 1,
                reason: `${itemName} yap`
            })
        ];
    }

    expandSmeltingSetup(visited) {
        return [
            ...this.expandAcquire('furnace', 1, {}, visited),
            ...this.expandAnyPlanks(1, visited)
        ];
    }

    craftingTableTask() {
        if (this.hasCraftingTableAccess()) return [];
        return [this.goalTask({
            type: 'acquire_item',
            item: 'crafting_table',
            count: 1,
            reason: 'Crafting table yap'
        })];
    }

    hasCraftingTableAccess() {
        if (this.itemCount('crafting_table') > 0) return true;
        if (this.memory?.data?.craftingTables?.length) return true;
        const tableId = this.goalPlanner?.bot?.registry?.blocksByName?.crafting_table?.id;
        if (tableId == null || typeof this.goalPlanner?.bot?.findBlock !== 'function') return false;
        return Boolean(this.goalPlanner.bot.findBlock({
            matching: tableId,
            maxDistance: 8
        }));
    }

    planksNeededForSticks(stickCount) {
        return Math.ceil(Math.max(0, stickCount) / 4) * 2;
    }

    expandAnyPlanks(count, visited) {
        if (count <= 0) return [];
        const currentPlanks = this.itemCountBySuffix('_planks');
        if (currentPlanks >= count) return [];

        const missingPlanks = count - currentPlanks;
        const requiredLogs = Math.ceil(missingPlanks / 4);
        const logTasks = this.inventoryLogCount() >= requiredLogs
            ? []
            : this.expandAnyLogs(requiredLogs, visited);

        const log = this.firstInventoryLog();
        if (log) {
            const planks = this.planksForLog(log.name) || 'oak_planks';
            return [...logTasks, this.goalTask({
                type: 'acquire_item',
                item: planks,
                count,
                reason: 'Tahta kalas yap'
            })];
        }

        return logTasks
            .concat(this.goalTask({
                type: 'acquire_item',
                item: 'oak_planks',
                count,
                reason: 'Tahta kalas yap'
            }));
    }

    expandAnyLogs(count, visited) {
        if (this.inventoryLogCount() >= count) return [];
        if (visited.has('oak_log')) return [];
        return [this.goalTask({
            type: 'acquire_item',
            item: 'oak_log',
            count,
            reason: 'Odun topla'
        })];
    }

    nextAction(queue, observation = {}) {
        while (queue.length > 0 && this.isTaskComplete(queue[0], observation)) {
            queue.shift();
        }

        const task = queue[0];
        if (!task) return { complete: true };

        if (task.kind === 'action') {
            return { task, action: task.action };
        }

        const action = this.goalPlanner.plan(task.goal, observation);
        return { task, action };
    }

    isTaskComplete(task, observation = {}) {
        if (!task) return true;
        if (task.kind === 'action') return Boolean(task.done);
        if (this.isEquivalentToolComplete(task.goal)) return true;
        return this.goalPlanner.isGoalComplete(task.goal, observation);
    }

    isEquivalentToolComplete(goal) {
        if (goal?.type !== 'acquire_item') return false;
        const match = goal.item.match(
            /^(wooden|stone|golden|iron|diamond|netherite)_(pickaxe|axe|sword|hoe|shovel)$/
        );
        if (!match) return false;

        const [, tier, toolType] = match;
        const tiers = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'];
        const minRank = tiers.indexOf(tier);
        return this.goalPlanner?.bot?.inventory?.items?.().some(item => {
            const itemMatch = item.name.match(
                /^(wooden|stone|golden|iron|diamond|netherite)_(pickaxe|axe|sword|hoe|shovel)$/
            );
            return itemMatch &&
                itemMatch[2] === toolType &&
                tiers.indexOf(itemMatch[1]) >= minRank;
        });
    }

    completeActionTask(task) {
        if (task?.kind === 'action') task.done = true;
    }

    goalTask(goal) {
        return {
            kind: 'goal',
            goal,
            label: this.describeGoal(goal)
        };
    }

    actionTask(action) {
        return {
            kind: 'action',
            action,
            label: action.type
        };
    }

    foodReserveTask() {
        return this.goalTask({
            type: 'find_food',
            count: 16,
            reason: 'Buyuk isten once 16 yemek stogu hazirla'
        });
    }

    seedTarget() {
        const planted = this.memory?.data?.farmInProgress?.planted || 0;
        return planted > 0 ? Math.max(1, 8 - planted) : 8;
    }

    expandSeedTarget() {
        const planted = this.memory?.data?.farm?.cropCount || 8;
        return Math.max(1, 24 - planted);
    }

    hasItemOrEquivalent(itemName, count = 1) {
        if (this.itemCount(itemName) >= count) return true;
        const match = itemName.match(
            /^(wooden|stone|golden|iron|diamond|netherite)_(pickaxe|axe|sword|hoe|shovel)$/
        );
        if (!match) return false;

        const [, tier, toolType] = match;
        const tiers = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'];
        const minRank = tiers.indexOf(tier);
        return this.goalPlanner?.bot?.inventory?.items?.().some(item => {
            const itemMatch = item.name.match(
                /^(wooden|stone|golden|iron|diamond|netherite)_(pickaxe|axe|sword|hoe|shovel)$/
            );
            return itemMatch &&
                itemMatch[2] === toolType &&
                tiers.indexOf(itemMatch[1]) >= minRank;
        });
    }

    itemCount(itemName) {
        return this.goalPlanner?.bot?.inventory?.items?.()
            .filter(item => item.name === itemName)
            .reduce((total, item) => total + item.count, 0) || 0;
    }

    itemCountBySuffix(suffix) {
        return this.goalPlanner?.bot?.inventory?.items?.()
            .filter(item => item.name.endsWith(suffix))
            .reduce((total, item) => total + item.count, 0) || 0;
    }

    inventoryLogCount() {
        return this.goalPlanner?.bot?.inventory?.items?.()
            .filter(item => this.isWoodLogItem(item.name))
            .reduce((total, item) => total + item.count, 0) || 0;
    }

    firstInventoryLog() {
        return this.goalPlanner?.bot?.inventory?.items?.()
            .find(item => this.isWoodLogItem(item.name)) || null;
    }

    isWoodLogItem(name) {
        return typeof name === 'string' && (
            name.endsWith('_log') ||
            name.endsWith('_wood') ||
            name.endsWith('_stem') ||
            name.endsWith('_hyphae') ||
            name === 'bamboo_block'
        );
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

    armorTasks(material, reason) {
        const pieces = ['helmet', 'chestplate', 'leggings', 'boots'];
        return [
            ...pieces.map(piece =>
                this.goalTask({
                    type: 'acquire_item',
                    item: `${material}_${piece}`,
                    count: 1,
                    reason: `${material} zirh parcasi: ${piece}`
                })
            ),
            this.goalTask({
                type: `equip_${material}_armor`,
                reason
            })
        ];
    }

    describeGoal(goal) {
        return goal.type === 'acquire_item'
            ? `${goal.item} x${goal.count}`
            : goal.type;
    }
}

module.exports = TaskPlanner;
