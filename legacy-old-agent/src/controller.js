const { Vec3 } = require('vec3');
const { safeFoodInventoryCount, sleep } = require('./utils');
const CombatSurvival = require('./combat-survival');
const SurvivalStateMachine = require('./state-machine');
const TaskPlanner = require('./task-planner');

class Controller {
    constructor(options) {
        this.bot = options.bot;
        this.perception = options.perception;
        this.localAgent = options.localAgent;
        this.planner = options.planner;
        this.skills = options.skills;
        this.lifeManager = options.lifeManager;
        this.memory = options.memory;
        this.combatSurvival = options.combatSurvival ||
            new CombatSurvival({
                bot: this.bot,
                memory: this.memory
            });
        this.stateMachine = options.stateMachine ||
            new SurvivalStateMachine({
                bot: this.bot,
                memory: this.memory,
                lifeManager: this.lifeManager,
                combatSurvival: this.combatSurvival
            });
        this.taskPlanner = options.taskPlanner ||
            new TaskPlanner({
                goalPlanner: this.planner,
                memory: this.memory
            });
        this.tickDelayMs = options.tickDelayMs || 1000;

        this.running = false;
        this.paused = false;
        this.goal = null;
        this.goalFailures = 0;
        this.completedGoals = [
           ...(this.memory?.data.completedGoals || [])
        ].slice(-20);
        this.lastFailedGoal = null;
        this.recentAttackerId = null;
        this.recentDamageAt = 0;
        this.escapeUntil = 0;
        this.executingDangerReflex = false;
        this.executingSurvivalAction = false;
        this.treeMaintenanceIntervalMs = options.treeMaintenanceIntervalMs || 60000;
        this.statusIntervalMs = options.statusIntervalMs || 30000;
        this.lastStatusAt = 0;
        this.pendingPriorityGoals = null;
        this.currentActionType = null;
        this.foodSearchSuppressedUntil = 0;
        this.taskQueue = [];
        this.taskQueueGoal = null;
        this.currentTask = null;
    }

    async start() {
        if (this.running) return;
        this.running = true;
        console.log('Yerel ajan dongusu baslatildi.');

        while (this.running) {
            if (this.paused ||!this.bot.entity) {
                await sleep(500);
                continue;
            }

            try {
                await this.tick();
            } catch (error) {
                console.log('Ajan adimi basarisiz:', error.message);
                this.skills.stop();
                this.goalFailures += 1;

                if (this.goalFailures >= 3) {
                    console.log('Hedef uc kez basarisiz oldu, yeni hedef secilecek.');
                    if (this.goal?.type === 'recover_items') {
                        console.log('Olum esyalarina ulasilamadi; recovery hedefi temizlendi.');
                        this.memory?.setFlag('deathPosition', null);
                    }
                    if (this.goal?.type === 'find_food') {
                        this.foodSearchSuppressedUntil = Date.now() + 60000;
                        console.log('Yiyecek arama 60 saniye bastirildi; diger hedefler denenecek.');
                    }
                    this.lastFailedGoal = this.goal
                       ? this.describeGoal(this.goal)
                        : null;
                    this.goal = null;
                    this.clearTaskQueue();
                    this.goalFailures = 0;
                }
            }

            await sleep(this.tickDelayMs);
        }
    }

    stop() {
        this.running = false;
        this.skills.cancelCurrentAction?.('Controller durduruldu') ||
            this.skills.stop();
    }

    pause() {
        this.paused = true;
        this.skills.cancelCurrentAction?.('Controller duraklatildi') ||
            this.skills.stop();
    }

    resume() {
        this.paused = false;
        this.clearCombatMemory();
        this.goal = null;
        this.goalFailures = 0;
    }

    clearCombatMemory() {
        this.ensureCombatSurvival().clear();
        this.syncCombatStateFromLayer();
        this.executingDangerReflex = false;
        this.executingSurvivalAction = false;
    }

    reportDamage(source = null) {
        this.ensureCombatSurvival().reportDamage(source);
        this.syncCombatStateFromLayer();
        const protectedAction = [
            'flee',
            'escape_pit',
            'fight',
            'swim'
        ].includes(this.currentActionType);

        if (!this.executingDangerReflex &&!protectedAction) {
            this.skills.cancelCurrentAction?.('Hasar nedeniyle mevcut aksiyon kesildi') ||
                this.skills.stop();
        }
    }

    emergency(action) {
        if (action === 'eat') {
            const food = this.lifeManager?.bestFood?.(true);
            if (food) {
                this.skills.execute({ type: 'eat', item: food.name, reason: 'Acil can yenileme' })
                  .catch(() => {});
            }
            return;
        }
        if (action === 'flee') {
            this.skills.cancelCurrentAction?.('Hasar - acil kacis') || this.skills.stop();
            this.recentDamageAt = Date.now();
        }
    }

    async tick() {
        if (this.bot.isSleeping) return;

        const observation = this.perception.observe();
        this.logStatus(observation);
        const dangerReflex = this.chooseDangerReflex(observation);
        const survivalOverride = dangerReflex
            ? this.survivalOverrideForDanger(observation, dangerReflex)
            : null;
        const transition = this.chooseStateTransition(
            observation,
            dangerReflex,
            survivalOverride
        );

        if (
            transition.type === 'action' &&
            transition.danger &&
            observation.inWater &&
            this.shouldHandleDangerBeforeSwimming(transition.action, observation)
        ) {
            console.log(`[STATE:${transition.state}] Refleks:`, transition.action);
            this.executingDangerReflex = true;
            this.currentActionType = transition.action.type;
            try {
                await this.skills.execute(transition.action);
            } finally {
                this.executingDangerReflex = false;
                this.currentActionType = null;
            }
            return;
        }

        if (
            transition.type === 'action' &&
            transition.action.type === 'swim'
        ) {
            console.log(`[STATE:${transition.state}] Refleks:`, transition.action);
            this.currentActionType = transition.action.type;
            try {
                await this.skills.execute(transition.action);
            } finally {
                this.currentActionType = null;
            }
            return;
        }

        if (transition.type === 'action' && transition.danger) {
            console.log(`[STATE:${transition.state}] Refleks:`, transition.action);
            this.executingDangerReflex = true;
            this.currentActionType = transition.action.type;
            try {
                await this.skills.execute(transition.action);
            } finally {
                this.executingDangerReflex = false;
                this.currentActionType = null;
            }
            return;
        }

        this.pendingPriorityGoals = null;
        if (transition.type === 'action') {
            console.log(`[STATE:${transition.state}] Yasam ihtiyaci:`, transition.action);
            this.executingSurvivalAction = this.isSurvivalAction(transition.action);
            this.currentActionType = transition.action.type;
            try {
                await this.skills.execute(transition.action);
            } finally {
                this.executingSurvivalAction = false;
                this.currentActionType = null;
            }
            return;
        }
        if (transition.type === 'goals') {
            const priorityGoals = this.filterPriorityGoals(
                transition.goals,
                observation
            );
            if (priorityGoals.length > 0) {
                this.pendingPriorityGoals = priorityGoals;
                this.goal = null;
            }
        }

        if (this.goal && this.planner.isGoalComplete(this.goal, observation)) {
            console.log('Hedef tamamlandi:', this.goal);
            const description = this.describeGoal(this.goal);
            this.completedGoals.push(description);
            this.completedGoals = this.completedGoals.slice(-20);
            this.memory?.completeGoal(description);
            this.goal = null;
            this.clearTaskQueue();
            this.goalFailures = 0;
        }

        if (!this.goal) {
            console.log(`[STATE:${transition.state}] Stratejik hedef seciliyor.`);
            this.goal = await this.selectGoal(observation);
            this.lastFailedGoal = null;
            this.createTaskQueueForGoal(this.goal, observation);
            console.log('Yeni hedef:', this.goal);
        }

        const planned = this.nextQueuedAction(this.goal, observation);
        let action = planned.action;
        if (action.type === 'complete') {
            this.taskQueue.shift();
            return;
        }

        if (action.type === 'blocked') {
            throw new Error(action.reason);
        }

        if (this.shouldPrepareCraftAtBase(this.goal, action)) {
            action = {
                type: 'return_base',
                reason: 'Uretim isi ana usteki crafting table yakininda yapilmali'
            };
        } else if (this.skills.shouldReturnToBase(action)) {
            action = {
                type: 'return_base',
                reason: 'Bu is ana us yakininda yapilmali'
            };
        } else if (this.skills.shouldReturnToSurface(action)) {
            action = {
                type: 'return_surface',
                reason: action.type === 'build_shelter'
                   ? 'Barinak yuzeyde kurulur; maden girisine geri don'
                    : action.type === 'hunt_food'
                       ? 'Yiyecek yuzeyde aranir; once maden girisine geri don'
                        : 'Odun yuzeyde bulunur; maden girisine geri don'
            };
        }

        console.log(
            'Uygulanan plan adimi:',
            action,
            '| Envanter:',
            observation.inventory.text,
            '| Konum:',
            observation.position
        );
        this.executingSurvivalAction = this.isSurvivalAction(action);
        this.currentActionType = action.type;
        try {
            await this.skills.execute(action);
            this.taskPlanner.completeActionTask(this.currentTask);
        } finally {
            this.executingSurvivalAction = false;
            this.currentActionType = null;
            this.currentTask = null;
        }

        if (action.type === 'explore') {
            this.goal = null;
            this.clearTaskQueue();
            this.goalFailures = 0;
        }
        if (action.type === 'maintain_tree_garden') {
            this.goal = null;
            this.clearTaskQueue();
            this.goalFailures = 0;
        }
    }

    createTaskQueueForGoal(goal, observation) {
        this.taskPlanner?.updateContext?.({
            goalPlanner: this.planner,
            memory: this.memory
        });
        this.taskQueueGoal = this.describeGoal(goal);
        this.taskQueue = this.taskPlanner.createQueue(goal, observation);
        const labels = this.taskQueue.map(task => task.label).join(' -> ');
        console.log(`[TASK_QUEUE:${this.taskQueueGoal}] ${labels || 'bos'}`);
    }

    nextQueuedAction(goal, observation) {
        const goalDescription = this.describeGoal(goal);
        if (this.taskQueueGoal !== goalDescription || this.taskQueue.length === 0) {
            this.createTaskQueueForGoal(goal, observation);
        }

        const result = this.taskPlanner.nextAction(this.taskQueue, observation);
        if (result.complete) {
            return { action: { type: 'complete' } };
        }

        this.currentTask = result.task;
        if (result.task?.label) {
            console.log(`[TASK:${result.task.label}] Siradaki eylem:`, result.action);
        }
        return result;
    }

    clearTaskQueue() {
        this.taskQueue = [];
        this.taskQueueGoal = null;
        this.currentTask = null;
    }

    chooseStateTransition(observation, dangerReflex, survivalOverride = null) {
        this.stateMachine?.updateContext?.({
            bot: this.bot,
            memory: this.memory,
            lifeManager: this.lifeManager,
            combatSurvival: this.combatSurvival
        });
        return this.stateMachine.choose(observation, {
            dangerReflex,
            survivalOverride
        });
    }

    filterPriorityGoals(goals, observation) {
        if (!Array.isArray(goals) || goals.length === 0) return [];
        return goals.filter(goal => {
            const isFoodStockTopUp =
                goal.type === 'find_food' &&
                goal.count === 16 &&
                safeFoodInventoryCount(this.bot) >= 12;
            if (
                isFoodStockTopUp &&
                this.goal &&
                this.goal.type!== 'find_food' &&
               !this.planner.isGoalComplete(this.goal, observation)
            ) {
                console.log(
                    'Yemek stogu yeterli; mevcut hedef bitene kadar top-up ertelendi.'
                );
                return false;
            }
            return true;
        });
    }

    survivalOverrideForDanger(observation, dangerReflex) {
        if (!dangerReflex || dangerReflex.type!== 'flee') return null;
        if (!observation.isNight) return null;
        if (this.bot.game?.difficulty === 'peaceful') return null;
        if (dangerReflex.threat === 'creeper') return null;
        if (observation.health <= 12) return null;
        if (observation.food <= 4) return null;
        if ((dangerReflex.distance || 0) <= 4) return null;
        if (
            ['spider', 'cave_spider', 'slime', 'zombie_villager'].includes(dangerReflex.threat) &&
            (dangerReflex.distance || 0) <= 8
        ) {
            return null;
        }
        if (
            dangerReflex.threat === 'skeleton' &&
            (dangerReflex.distance || 0) <= 10
        ) {
            return null;
        }

        const base = this.memory?.data.base || this.memory?.data.shelter;
        if (!base ||!observation.position) return null;
        const hasWeapon = this.bot.inventory.items()
           .some(item =>
                item.name.endsWith('_sword') ||
                item.name.endsWith('_axe')
            );
        if (hasWeapon) return null;

        const position = new Vec3(
            observation.position.x,
            observation.position.y,
            observation.position.z
        );
        const distanceToBase = position.distanceTo(
            new Vec3(base.x, base.y, base.z)
        );
        if (distanceToBase > 64) return null;

        return {
            type: 'survive_night',
            reason: 'Gece silahsiz ve base yakin; rastgele kacmak yerine eve don'
        };
    }

    chooseDangerReflex(observation) {
        this.syncCombatStateToLayer();
        const action = this.ensureCombatSurvival().chooseAction(observation);
        this.syncCombatStateFromLayer();
        return action;
    }

    shouldHandleDangerBeforeSwimming(action, observation = null) {
        if (!action) return false;
        if (observation?.inWater && action.type === 'flee') return false;
        if (action.threat && action.threat!== 'gece') return true;
        return ['fight', 'flee', 'barricade_shelter', 'escape_pit'].includes(action.type) &&
            action.type!== 'swim';
    }

    ensureCombatSurvival() {
        if (!this.combatSurvival) {
            this.combatSurvival = new CombatSurvival({
                bot: this.bot,
                memory: this.memory
            });
        }
        this.combatSurvival.updateContext({
            bot: this.bot,
            memory: this.memory
        });
        return this.combatSurvival;
    }

    syncCombatStateToLayer() {
        const layer = this.ensureCombatSurvival();
        layer.recentAttackerId = this.recentAttackerId;
        layer.recentDamageAt = this.recentDamageAt || 0;
        layer.escapeUntil = this.escapeUntil || 0;
    }

    syncCombatStateFromLayer() {
        const layer = this.ensureCombatSurvival();
        this.recentAttackerId = layer.recentAttackerId;
        this.recentDamageAt = layer.recentDamageAt;
        this.escapeUntil = layer.escapeUntil;
    }

    hasCombatWeapon() {
        return this.bot.inventory.items().some(item =>
            item.name.endsWith('_sword') ||
            item.name.endsWith('_axe')
        );
    }

    isSurvivalAction(action) {
        return [
            'survive_night',
            'return_base',
            'return_surface',
            'escape_pit',
            'barricade_shelter',
            'emergency_shelter'
        ].includes(action.type);
    }

    countEmergencyBuildBlocks(observation) {
        const items = observation.inventory.items || {};
        return [
            'dirt',
            'grass_block',
            'coarse_dirt',
            'podzol',
            'cobblestone',
            'cobbled_deepslate',
            'tuff',
            'deepslate',
            'stone',
            'oak_planks'
        ].reduce((total, name) => total + (items[name] || 0), 0);
    }

    isLikelyInPit(observation) {
        const y =
            observation.position?.y??
            this.bot.entity?.position?.y;
        if (y == null) return false;

        const referenceY =
            this.memory?.data.base?.y??
            this.memory?.data.shelter?.y??
            this.memory?.data.surfaceAnchor?.y??
            this.memory?.data.home?.y;
        if (referenceY == null) return false;

        return y <= Math.max(1, referenceY) - 1;
    }

    shouldPrepareCraftAtBase(goal, action) {
        const base = this.memory?.data.base || this.memory?.data.shelter;
        if (!base || goal?.type!== 'acquire_item') return false;

        const portableRecoveryItems = new Set([
            'wooden_pickaxe',
            'stone_pickaxe',
            'stone_axe',
            'stone_sword'
        ]);
        if (portableRecoveryItems.has(goal.item)) return false;

        const baseCraftedItem =
            /_(pickaxe|axe|sword|hoe|helmet|chestplate|leggings|boots)$/.test(goal.item) ||
            ['bucket', 'chest', 'furnace'].includes(goal.item);
        if (!baseCraftedItem) return false;

        const farFromBase = this.bot.entity.position.distanceTo(
            new Vec3(base.x, base.y, base.z)
        ) > 10;
        if (!farFromBase) return false;
        if (
            action.type === 'craft' &&
            action.requiresTable &&
            this.hasNearbyCraftingTable()
        ) {
            return false;
        }

        return (
            action.type === 'craft' && action.requiresTable
        ) || action.type === 'place_workstation';
    }

    hasNearbyCraftingTable(maxDistance = 5) {
        const tableId = this.bot.registry.blocksByName.crafting_table?.id;
        if (tableId == null || typeof this.bot.findBlock!== 'function') {
            return false;
        }
        return Boolean(this.bot.findBlock({
            matching: tableId,
            maxDistance
        }));
    }

    async selectGoal(observation) {
        const candidates = this.createCandidates(observation);
        if (candidates.length === 1) {
            return candidates[0];
        }

        try {
            const proposed = await this.localAgent.selectGoal(
                observation,
                {
                    completed: this.completedGoals,
                    failures: this.lastFailedGoal? [this.lastFailedGoal] : []
                },
                candidates
            );
            const validated = this.planner.validateGoal(proposed);

            if (validated && this.isCandidate(validated, candidates)) {
                return validated;
            }
        } catch (error) {
            console.log('Ollama hedef secemedi:', error.message);
        }

        return candidates[0];
    }

    createCandidates(observation) {
        const priorityGoals = this.pendingPriorityGoals ||
            this.lifeManager?.createPriorityGoals(observation) ||
            [];
        this.pendingPriorityGoals = null;
        if (
            priorityGoals.length > 0 &&
            (
                this.lastFailedGoal === 'find_food' ||
                Date.now() < this.foodSearchSuppressedUntil
            ) &&
            observation.health > 6 &&
            observation.food > 10
        ) {
            const filteredPriorityGoals = priorityGoals.filter(goal =>
                goal.type!== 'find_food'
            );
            if (filteredPriorityGoals.length > 0) return filteredPriorityGoals;
            console.log('Yiyecek arama gecici basarisiz; diger hedeflere kisa sure izin veriliyor.');
        } else if (priorityGoals.length > 0) {
            return priorityGoals;
        }
        const deathPosition = this.memory?.data.deathPosition;
        if (this.shouldRecoverDeathItems(deathPosition, observation)) {
            return [{
                type: 'recover_items',
                reason: 'Olum noktasindaki esyalari kaybolmadan geri al'
            }];
        }
        if (deathPosition) {
            if (this.shouldDeferDeathRecovery(deathPosition, observation)) {
                console.log('Olum esyalari tehlikeli bolgede; once ekipman ve hayatta kalma hazirligi yapilacak.');
            } else {
                console.log('Olum noktasinda kayda deger esya yok; kurtarma hedefi atlandi.');
                this.memory?.setFlag('deathPosition', null);
            }
        }

        const milestones = [
            'wooden_pickaxe',
            'stone_pickaxe',
            'stone_axe',
            'stone_sword',
            'furnace'
        ];
        const goals = milestones
           .filter(item =>
               !this.hasMilestoneOrBetter(item, observation.inventory.items) &&
                this.bot.registry.itemsByName[item] &&
                this.lastFailedGoal!== `${item} x1`
            )
           .slice(0, 2)
           .map(item => ({
                type: 'acquire_item',
                item,
                count: 1,
                reason: 'Minecraft gelisim hedefi'
            }));

        if (goals.length > 0) return goals;

        if (!this.memory?.data.shelter) {
            const cobblestone = observation.inventory.items.cobblestone || 0;
            if (cobblestone < 24) {
                return [{
                    type: 'acquire_item',
                    item: 'cobblestone',
                    count: 24,
                    reason: 'Ilk barinak icin yapi malzemesi topla'
                }];
            }

            if (this.lastFailedGoal === 'build_shelter') {
                return [{
                    type: 'explore',
                    reason: 'Barinak icin daha duz bir alan ara'
                }];
            }

            return [{
                type: 'build_shelter',
                reason: 'Gece ve dusmanlar icin kalici ilk barinak kur'
            }];
        }

        const middleGameGoals = this.createMiddleGameGoals(observation);
        if (middleGameGoals.length > 0) return middleGameGoals;

        const diamondAgeGoals = this.createDiamondAgeGoals(observation);
        return diamondAgeGoals.length > 0
           ? diamondAgeGoals
            : [this.createIdleGoal('Tum ana hedefler tamam; bahceyi periyodik kontrol et')];
    }

    shouldRecoverDeathItems(death, observation = null) {
        if (!death || (death.itemCount || 0) <= 0) return false;
        if (death.damageSource === 'drowned') return false;
        if (this.shouldDeferDeathRecovery(death, observation)) return false;

        const items = Array.isArray(death.items)? death.items : [];
        if (items.length === 0) return (death.itemCount || 0) >= 16;

        const valuable = /(_pickaxe|_axe|_sword|_helmet|_chestplate|_leggings|_boots|diamond|iron|bucket|bed|furnace|crafting_table|torch|cooked_|porkchop|beef|mutton|bread|apple)/;
        return items.some(item => valuable.test(item.name)) ||
            (death.itemCount || 0) >= 16;
    }

    shouldDeferDeathRecovery(death, observation = null) {
        if (!death || (death.itemCount || 0) <= 0) return false;
        const hostileDeath = [
            'zombie',
            'zombie_villager',
            'husk',
            'skeleton',
            'stray',
            'spider',
            'cave_spider',
            'creeper',
            'slime',
            'witch',
            'pillager'
        ].includes(death.damageSource);
        if (!hostileDeath) return false;

        const inventory = observation?.inventory?.items || {};
        const hasWeapon = Object.keys(inventory)
            .some(name => /_(sword|axe)$/.test(name) && (inventory[name] || 0) > 0);
        const referenceY =
            this.memory?.data.surfaceAnchor?.y ??
            this.memory?.data.base?.y ??
            this.memory?.data.shelter?.y ??
            observation?.position?.y;
        const deepDeath = referenceY != null && death.y <= referenceY - 8;
        const nearbyHostile = (observation?.hostileMobs || [])
            .some(mob => mob.distance <= 24);
        const fragile = (observation?.health ?? 20) < 14 || (observation?.food ?? 20) < 8;

        return !hasWeapon && (
            deepDeath ||
            nearbyHostile ||
            observation?.isNight ||
            fragile
        );
    }

    createMiddleGameGoals(observation) {
        const inventory = observation.inventory.items;
        const itemGoal = (item, count, reason) => ({
            type: 'acquire_item',
            item,
            count,
            reason
        });

        const hasKnownBed = this.memory?.data.beds?.length > 0;
        const carriedBed = this.bot.inventory.items()
           .find(item => item.name.endsWith('_bed'));
        if (!hasKnownBed && carriedBed) {
            return [{
                type: 'place_bed',
                reason: 'Respawn noktasini ana usse tasimak icin yatagi kur'
            }];
        }

        if (!this.hasMilestoneOrBetter('stone_sword', inventory)) {
            return [itemGoal('stone_sword', 1, 'Madende savunma icin kilic yap')];
        }
        if (!this.memory?.data.upgradedBase && (inventory.oak_planks || 0) < 24) {
            return [itemGoal(
                'oak_planks',
                24,
                'Ana us gelistirmesi icin tahta hazirla'
            )];
        }
        if (!this.memory?.data.upgradedBase) {
            return [{
                type: 'upgrade_base',
                reason: 'Ilk barinagi daha kullanisli bir ana usse cevir'
            }];
        }
        if (!this.memory?.data.mine) {
            return [{
                type: 'establish_mine',
                reason: 'Base yakininda guvenli capraz maden girisi kur'
            }];
        }
        const waterUnavailable = Boolean(this.memory?.data.waterUnavailable);
        if (!this.memory?.data.farm) {
            if (this.memory?.data.farmInProgress) {
                const planted = this.memory.data.farmInProgress.planted || 0;
                const seedsNeeded = Math.max(0, 8 - planted);
                const dryFarm =
                    waterUnavailable ||
                    (
                       !inventory.water_bucket &&
                       !this.memory.data.farmInProgress.waterPlaced
                    );
                if ((inventory.wheat_seeds || 0) < seedsNeeded) {
                    return [itemGoal(
                        'wheat_seeds',
                        seedsNeeded,
                        'Baslanan tarladaki eksik siralari tamamla'
                    )];
                }
                return [{
                    type: 'build_farm',
                    dry: dryFarm,
                    reason: dryFarm
                       ? 'Baslanan kuru bugday tarlasini tamamla'
                        : 'Baslanan sulanan bugday tarlasini tamamla'
                }];
            }
            if ((inventory.wheat_seeds || 0) < 8) {
                return [itemGoal('wheat_seeds', 8, 'Tarla icin bugday tohumu topla')];
            }
            if (!inventory.stone_hoe &&!inventory.iron_hoe) {
                return [itemGoal('stone_hoe', 1, 'Tarla topragini surmek icin capa yap')];
            }
            const dryFarm = waterUnavailable ||!inventory.water_bucket;
            return [{
                type: 'build_farm',
                dry: dryFarm,
                reason: dryFarm
                   ? 'Erken yemek guvencesi icin kuru baslangic bugday tarlasi kur'
                    : 'Base yanina sulanan bugday tarlasi kur'
            }];
        }

        if (!this.memory?.data.storageSystem) {
            if ((inventory.chest || 0) < 3) {
                return [itemGoal(
                    'chest',
                    4,
                    'Yiyecek, maden ve insaat malzemeleri icin kategorili depo hazirla'
                )];
            }
            return [{
                type: 'organize_storage',
                reason: 'Ana us yakininda kategorili sandik duzeni kur'
            }];
        }

        if (!hasKnownBed && this.shouldSeekBed(observation, inventory)) {
            return [itemGoal(
                'white_bed',
                1,
                'Base ve tarla kuruldu; yakin koyun veya hazir yunden yatak edin'
            )];
        }

        if ((inventory.torch || 0) < 12) {
            return [itemGoal('torch', 12, 'Ilk madeni aydinlatmak icin mesale yap')];
        }
        if (!this.hasMilestoneOrBetter('iron_pickaxe', inventory)) {
            if ((inventory.diamond || 0) >= 3) {
                return [itemGoal(
                    'diamond_pickaxe',
                    1,
                    'Kirilan demir kazma yerine dogrudan elmas kazma yap'
                )];
            }
            return [itemGoal('iron_pickaxe', 1, 'Demir kazmaya gec')];
        }

        for (const item of ['iron_sword', 'iron_axe']) {
            if (!inventory[item]) {
                return [itemGoal(item, 1, `Orta oyun ekipmani: ${item}`)];
            }
        }

        if (!this.memory?.data.ironArmorEquipped) {
            for (const item of [
                'iron_helmet',
                'iron_chestplate',
                'iron_leggings',
                'iron_boots'
            ]) {
                if (!inventory[item]) {
                    return [itemGoal(item, 1, `Demir zirh parcasi: ${item}`)];
                }
            }

            return [{
                type: 'equip_iron_armor',
                reason: 'Tam demir zirhi kusan'
            }];
        }
        return [];
    }

    shouldSeekBed(observation, inventory) {
        if (observation.isNight) return false;
        if (!this.memory?.data.upgradedBase ||!this.memory?.data.farm) {
            return false;
        }

        const wool = Object.entries(inventory)
           .filter(([name]) => name.endsWith('_wool'))
           .reduce((total, [, count]) => total + count, 0);
        const planks = Object.entries(inventory)
           .filter(([name]) => name.endsWith('_planks'))
           .reduce((total, [, count]) => total + count, 0);
        if (wool >= 3 && planks >= 3) return true;

        return (observation.nearbyMobs || []).some(mob =>
            mob.name === 'sheep' && mob.distance <= 24
        );
    }

    createDiamondAgeGoals(observation) {
        const inventory = observation.inventory.items;
        const itemGoal = (item, count, reason) => ({
            type: 'acquire_item',
            item,
            count,
            reason
        });

        if (!this.memory?.data.beautifulHouse) {
            const needs = this.houseMaterialNeeds();
            if ((inventory.oak_planks || 0) < needs.oak_planks) {
                return [itemGoal(
                    'oak_planks',
                    needs.oak_planks,
                    'Estetik ahsap evin duvar ve catisi icin tahta hazirla'
                )];
            }
            if ((inventory.cobblestone || 0) < needs.cobblestone) {
                return [itemGoal(
                    'cobblestone',
                    needs.cobblestone,
                    'Ana evin tas temeli icin malzeme hazirla'
                )];
            }
            return [{
                type: 'build_house',
                reason: 'Tas temelli, ahsap kolonlu ve genis catili ana ev kur'
            }];
        }

        if (!this.memory?.data.storageSystem) {
            if ((inventory.chest || 0) < 4) {
                return [itemGoal(
                    'chest',
                    4,
                    'Kategorili ana depo icin dort sandik hazirla'
                )];
            }
            return [{
                type: 'organize_storage',
                reason: 'Ana evde kategorili sandik duzeni kur'
            }];
        }

        if (this.shouldPrepareLoadout(observation)) {
            return [{
                type: 'prepare_loadout',
                reason: 'Fazla esyalari bosalt ve mevcut hedefler icin temel loadout hazirla'
            }];
        }

        if (!this.memory?.data.expandedFarm) {
            const planted = this.memory?.data.farm?.cropCount || 8;
            const neededSeeds = Math.max(0, 24 - planted);
            if ((inventory.wheat_seeds || 0) < neededSeeds) {
                return [itemGoal(
                    'wheat_seeds',
                    neededSeeds,
                    'Buyuk bugday tarlasindaki eksik siralar icin tohum topla'
                )];
            }
            return [{
                type: 'expand_farm',
                reason: 'Sulanan bugday tarlasini 5x5 boyutuna buyut'
            }];
        }

        if (!this.memory?.data.treeGarden) {
            if ((inventory.oak_sapling || 0) < 3) {
                return [itemGoal(
                    'oak_sapling',
                    3,
                    'Ana us bahcesi icin uc mese fidani topla'
                )];
            }
            return [{
                type: 'establish_tree_garden',
                reason: 'Ana us yanina aralikli mese bahcesi dik'
            }];
        }

        const emptyTreeSpots = this.emptyGardenSpots();
        if (emptyTreeSpots > 0) {
            if ((inventory.oak_sapling || 0) < emptyTreeSpots) {
                return [itemGoal(
                    'oak_sapling',
                    emptyTreeSpots,
                    'Bos kalan bahce noktalarini yeniden dik'
                )];
            }
            return [{
                type: 'maintain_tree_garden',
                reason: 'Bos kalan agac noktalarini yeniden dik'
            }];
        }

        if (this.hasMatureGardenTree()) {
            return [{
                type: 'maintain_tree_garden',
                reason: 'Buyuyen bahce agaclarini kes ve yeniden dik'
            }];
        }

        if (!this.memory?.data.deepMine && (inventory.torch || 0) < 16) {
            return [itemGoal(
                'torch',
                16,
                'Derin elmas madeni icin yeterli mesale hazirla'
            )];
        }

        if (!this.memory?.data.deepMine) {
            return [{
                type: 'establish_deep_mine',
                reason: 'Elmas seviyesi icin guvenli derin maden kolu ac'
            }];
        }

        for (const item of [
            'diamond_pickaxe',
            'diamond_axe',
            'diamond_sword'
        ]) {
            if (!inventory[item]) {
                return [itemGoal(item, 1, `Elmas alet: ${item}`)];
            }
        }

        if (!this.memory?.data.diamondArmorEquipped) {
            for (const item of [
                'diamond_helmet',
                'diamond_chestplate',
                'diamond_leggings',
                'diamond_boots'
            ]) {
                if (!inventory[item]) {
                    return [itemGoal(item, 1, `Elmas zirh parcasi: ${item}`)];
                }
            }
            return [{
                type: 'equip_diamond_armor',
                reason: 'Tam elmas zirhi kusan'
            }];
        }

        const lastTreeMaintenanceAt = Date.parse(
            this.memory?.data.treeGarden?.lastMaintainedAt || ''
        );
        if (
            Number.isNaN(lastTreeMaintenanceAt) ||
            Date.now() - lastTreeMaintenanceAt >= this.treeMaintenanceIntervalMs
        ) {
            return [{
                type: 'maintain_tree_garden',
                reason: 'Agac bahcesini periyodik kontrol et'
            }];
        }
        return [];
    }

    createIdleGoal(reason) {
        return {
            type: 'idle',
            until: Date.now() + Math.min(this.treeMaintenanceIntervalMs, 60000),
            reason
        };
    }

    houseMaterialNeeds() {
        const base = this.memory?.data.base;
        if (!base) return { oak_planks: 108, cobblestone: 72 };
        const center = new Vec3(base.x, base.y, base.z - 14);
        let oakPlanks = 0;
        let cobblestone = 0;

        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                if (this.bot.blockAt(center.offset(dx, -1, dz))?.name!== 'cobblestone') {
                    cobblestone++;
                }
                const edge = Math.abs(dx) === 3 || Math.abs(dz) === 3;
                const doorway = dz === 3 && dx === 0;
                const window =
                    (Math.abs(dx) === 3 && dz === 0) ||
                    (Math.abs(dz) === 3 && Math.abs(dx) === 2);
                if (
                    edge &&
                   !doorway &&
                    this.bot.blockAt(center.offset(dx, 0, dz))?.name!== 'cobblestone'
                ) {
                    cobblestone++;
                }
                if (edge &&!doorway &&!window) {
                    for (const y of [1, 2]) {
                        if (this.bot.blockAt(center.offset(dx, y, dz))?.name!== 'oak_planks') {
                            oakPlanks++;
                        }
                    }
                }
                if (this.bot.blockAt(center.offset(dx, 3, dz))?.name!== 'oak_planks') {
                    oakPlanks++;
                }
            }
        }
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                if (this.bot.blockAt(center.offset(dx, 4, dz))?.name!== 'oak_planks') {
                    oakPlanks++;
                }
            }
        }
        return {
            oak_planks: oakPlanks,
            cobblestone
        };
    }

    hasMatureGardenTree() {
        const spots = this.memory?.data.treeGarden?.spots || [];
        const logIds = ['oak_log', 'oak_wood']
           .map(name => this.bot.registry.blocksByName[name]?.id)
           .filter(id => id!= null);
        return spots.some(spot =>
            this.bot.findBlock({
                matching: logIds,
                maxDistance: 4,
                point: new Vec3(spot.x, spot.y, spot.z)
            })
        );
    }

    emptyGardenSpots() {
        const spots = this.memory?.data.treeGarden?.spots || [];
        return spots.filter(spot => {
            const position = new Vec3(spot.x, spot.y, spot.z);
            const block = this.bot.blockAt(position);
            const trunk = this.bot.blockAt(position.offset(0, 1, 0));
            return!['oak_sapling', 'oak_log', 'oak_wood'].includes(block?.name) &&
                trunk?.name!== 'oak_log' &&
                trunk?.name!== 'oak_wood';
        }).length;
    }

    hasMilestoneOrBetter(itemName, inventory) {
        const tiers = [
            'wooden',
            'stone',
            'golden',
            'iron',
            'diamond',
            'netherite'
        ];
        const match = itemName.match(
            /^(wooden|stone|golden|iron|diamond|netherite)_(pickaxe|axe|sword|hoe|shovel)$/
        );
        if (!match) return Boolean(inventory[itemName]);

        const [, requiredTier, toolType] = match;
        const requiredRank = tiers.indexOf(requiredTier);
        return tiers.slice(requiredRank)
           .some(tier => inventory[`${tier}_${toolType}`]);
    }

    isCandidate(goal, candidates) {
        return candidates.some(candidate =>
            candidate.type === goal.type &&
            (
                goal.type === 'explore' ||
                goal.type === 'idle' ||
                goal.type === 'find_food' ||
                goal.type === 'build_shelter' ||
                goal.type === 'establish_mine' ||
                goal.type === 'build_farm' ||
                goal.type === 'place_bed' ||
                goal.type === 'survive_night' ||
                goal.type === 'recover_items' ||
                goal.type === 'emergency_shelter' ||
                goal.type === 'prepare_loadout' ||
                goal.type === 'upgrade_base' ||
                goal.type === 'equip_iron_armor' ||
                goal.type === 'build_house' ||
                goal.type === 'organize_storage' ||
                goal.type === 'expand_farm' ||
                goal.type === 'establish_tree_garden' ||
                goal.type === 'maintain_tree_garden' ||
                goal.type === 'establish_deep_mine' ||
                goal.type === 'equip_diamond_armor' ||
                goal.type === 'build_nether_portal' ||
                goal.type === 'enter_nether' ||
                candidate.item === goal.item
            )
        );
    }

    shouldPrepareLoadout(observation) {
        if (!this.memory?.data.storageSystem) return false;
        if (observation.inventory.emptySlots <= 8) return true;

        const inventory = observation.inventory.items;
        return (
            (inventory.raw_iron || 0) > 16 ||
            (inventory.iron_ingot || 0) > 16 ||
            (inventory.diamond || 0) > 8 ||
            (inventory.cobblestone || 0) > 64 ||
            (inventory.dirt || 0) > 64 ||
            (inventory.oak_planks || 0) > 64
        );
    }

    describeGoal(goal) {
        return goal.type === 'acquire_item'
           ? `${goal.item} x${goal.count}`
            : goal.type;
    }

    logStatus(observation) {
        if (Date.now() - this.lastStatusAt < this.statusIntervalMs) return;
        this.lastStatusAt = Date.now();

        const position = observation.position;
        const held = this.bot.heldItem?.name || 'bos_el';
        const armor = this.armorSummary();
        const goal = this.goal? this.describeGoal(this.goal) : 'yok';
        const threats = observation.hostileMobs
           .slice(0, 4)
           .map(mob => `${mob.name}@${mob.distance}`)
           .join(', ') || 'yok';

        console.log(
            `[STATUS] konum=(${position.x},${position.y},${position.z}) ` +
            `can=${observation.health.toFixed(1)}/20 ` +
            `aclik=${observation.food}/20 ` +
            `hedef=${goal} elde=${held} zirh=${armor} ` +
            `tehdit=${threats} envanter=${observation.inventory.text}`
        );
    }

    armorSummary() {
        const slots = this.bot.inventory?.slots || [];
        const pieces = [
            slots[5]?.name || 'helmet:yok',
            slots[6]?.name || 'chest:yok',
            slots[7]?.name || 'legs:yok',
            slots[8]?.name || 'boots:yok'
        ];
        return pieces.join('/');
    }
}

module.exports = Controller;
