const { Vec3 } = require('vec3');

const THREAT_PROFILES = {
    creeper: {
        kind: 'explosive',
        severity: 110,
        safeDistance: 12,
        avoid: true
    },
    skeleton: {
        kind: 'ranged',
        severity: 95,
        safeDistance: 18,
        avoid: true,
        strafe: true
    },
    stray: {
        kind: 'ranged',
        severity: 100,
        safeDistance: 18,
        avoid: true,
        strafe: true
    },
    pillager: {
        kind: 'ranged',
        severity: 90,
        safeDistance: 18,
        avoid: true,
        strafe: true
    },
    witch: {
        kind: 'magic',
        severity: 105,
        safeDistance: 16,
        avoid: true
    },
    enderman: {
        kind: 'burst_melee',
        severity: 95,
        safeDistance: 14,
        avoid: true
    },
    cave_spider: {
        kind: 'poison_melee',
        severity: 92,
        safeDistance: 12,
        avoid: true
    },
    slime: {
        kind: 'swarm',
        severity: 70,
        safeDistance: 9,
        fightHealth: 15,
        needsWeapon: true
    },
    magma_cube: {
        kind: 'swarm',
        severity: 82,
        safeDistance: 10,
        fightHealth: 16,
        needsWeapon: true
    },
    spider: {
        kind: 'melee_fast',
        severity: 70,
        safeDistance: 10,
        fightHealth: 14,
        needsWeapon: true
    },
    zombie: {
        kind: 'melee',
        severity: 55,
        safeDistance: 8,
        fightHealth: 12,
        needsWeapon: true
    },
    zombie_villager: {
        kind: 'melee',
        severity: 58,
        safeDistance: 8,
        fightHealth: 12,
        needsWeapon: true
    },
    drowned: {
        kind: 'melee',
        severity: 60,
        safeDistance: 9,
        fightHealth: 13,
        needsWeapon: true
    },
    husk: {
        kind: 'melee',
        severity: 62,
        safeDistance: 9,
        fightHealth: 13,
        needsWeapon: true
    },
    guardian: {
        kind: 'ranged',
        severity: 115,
        safeDistance: 20,
        avoid: true
    },
    elder_guardian: {
        kind: 'ranged',
        severity: 125,
        safeDistance: 24,
        avoid: true
    },
    phantom: {
        kind: 'flying',
        severity: 90,
        safeDistance: 18,
        avoid: true
    },
    vindicator: {
        kind: 'heavy_melee',
        severity: 100,
        safeDistance: 12,
        avoid: true
    },
    evoker: {
        kind: 'magic',
        severity: 120,
        safeDistance: 20,
        avoid: true
    },
    vex: {
        kind: 'flying',
        severity: 115,
        safeDistance: 16,
        avoid: true
    },
    piglin_brute: {
        kind: 'heavy_melee',
        severity: 115,
        safeDistance: 14,
        avoid: true
    },
    zoglin: {
        kind: 'heavy_melee',
        severity: 105,
        safeDistance: 14,
        avoid: true
    },
    wither_skeleton: {
        kind: 'heavy_melee',
        severity: 105,
        safeDistance: 14,
        avoid: true
    }
};

const DEFAULT_PROFILE = {
    kind: 'unknown',
    severity: 70,
    safeDistance: 10,
    avoid: true
};

class CombatSurvival {
    constructor(options = {}) {
        this.bot = options.bot;
        this.memory = options.memory || null;
        this.recentAttackerId = null;
        this.recentDamageAt = 0;
        this.escapeUntil = 0;
    }

    updateContext({ bot, memory } = {}) {
        if (bot) this.bot = bot;
        if (memory) this.memory = memory;
    }

    reportDamage(source = null) {
        if (source?.id != null) {
            this.recentAttackerId = source.id;
        }
        this.recentDamageAt = Date.now();
        this.escapeUntil = Date.now() + 18000;
    }

    clear() {
        this.recentAttackerId = null;
        this.recentDamageAt = 0;
        this.escapeUntil = 0;
    }

    chooseAction(observation) {
        const recentDamage = this.wasRecentlyDamaged(6000);
        const threat = this.selectThreat(observation, recentDamage);

        if (!threat) {
            return this.recoveryAction(observation);
        }

        const profile = this.profile(threat.name);
        const capabilities = this.capabilities(observation);
        const vulnerableNight =
            observation.isNight &&
            !this.memory?.data.shelter &&
            (
                observation.health <= 12 ||
                !capabilities.hasWeapon
            );
        const passiveIgnoreDistance = profile.kind === 'explosive'
            ? profile.safeDistance + 4
            : profile.safeDistance + 6;
        if (
            !recentDamage &&
            threat.distance > passiveIgnoreDistance &&
            !vulnerableNight
        ) {
            return this.recoveryAction(observation);
        }

        if (
            this.isInsideShelter(observation) &&
            threat.distance >= 4 &&
            !recentDamage
        ) {
            return null;
        }

        if (
            this.isInsideShelter(observation) &&
            !recentDamage &&
            !profile.avoid &&
            !this.canSeeThreat(threat)
        ) {
            return this.recoveryAction(observation);
        }

        if (this.isLikelyInPit(observation)) {
            return {
                type: 'escape_pit',
                targetId: threat.id,
                threat: threat.name,
                reason: `${threat.name} tehdidi var ama bot cukurda; once yukari cik`
            };
        }

        const emergencyShelter = this.emergencyShelterAction(
            observation,
            threat,
            profile,
            capabilities
        );
        if (emergencyShelter) return emergencyShelter;

        const barricade = this.barricadeAction(
            observation,
            threat,
            profile,
            capabilities
        );
        if (barricade) return barricade;

        const shelterLastStand = this.shelterLastStandAction(
            observation,
            threat,
            profile,
            capabilities,
            recentDamage
        );
        if (shelterLastStand) return shelterLastStand;

        const corneredFight = this.corneredFightAction(
            observation,
            threat,
            profile,
            capabilities
        );
        if (corneredFight) return corneredFight;

        const lastChanceFight = this.lastChanceMeleeFightAction(
            observation,
            threat,
            profile,
            capabilities
        );
        if (lastChanceFight) return lastChanceFight;

        const closeRangedFight = this.closeRangedFightAction(
            observation,
            threat,
            profile,
            capabilities
        );
        if (closeRangedFight) return closeRangedFight;

        const defensiveBarricade = this.defensiveBarricadeAction(
            observation,
            threat,
            profile,
            capabilities
        );
        if (defensiveBarricade) return defensiveBarricade;

        if (this.mustAvoid(threat, profile, observation, capabilities)) {
            return this.fleeAction(threat, observation, profile);
        }

        if (this.canFight(threat, profile, observation, capabilities)) {
            return {
                type: 'fight',
                targetId: threat.id,
                threat: threat.name,
                reason: recentDamage
                    ? `${threat.name} saldirisina karsilik ver`
                    : `${threat.name} yakin tehdit`
            };
        }

        if (!recentDamage && threat.distance > profile.safeDistance + 2) {
            return this.recoveryAction(observation);
        }

        return this.fleeAction(threat, observation, profile);
    }

    recoveryAction(observation) {
        const recoveringFromHit =
            observation.health < 14 &&
            Date.now() - this.recentDamageAt < 25000;

        if (
            (Date.now() < this.escapeUntil || recoveringFromHit) &&
            this.isLikelyInPit(observation)
        ) {
            return {
                type: 'escape_pit',
                targetId: null,
                threat: 'bilinmeyen_saldirgan',
                reason: recoveringFromHit
                    ? `Can dusuk ve bot cukurda: ${observation.health}/20`
                    : 'Hasar sonrasi cukurdan cik'
            };
        }

        if (Date.now() < this.escapeUntil || recoveringFromHit) {
            return {
                type: 'flee',
                targetId: null,
                threat: 'bilinmeyen_saldirgan',
                reason: recoveringFromHit
                    ? `Can toparlanana kadar uzaklas: ${observation.health}/20`
                : 'Hasar sonrasi guvenli mesafe olustur'
            };
        }

        if (
            observation.isNight &&
            !this.memory?.data.shelter &&
            observation.health <= 12
        ) {
            if (
                this.countEmergencyBuildBlocks(observation) >= 2 &&
                this.bot?.entity?.position?.y >= 1
            ) {
                return {
                    type: 'emergency_shelter',
                    targetId: null,
                    threat: 'gece',
                    reason: `Gece ve can dusuk (${observation.health}/20); acil siper kur`
                };
            }

            return {
                type: 'idle',
                until: Date.now() + 10000,
                reason: `Gece ve can dusuk (${observation.health}/20); gorunur tehdit yokken bekle`
            };
        }

        if (
            observation.health <= 6 &&
            observation.food >= 18
        ) {
            return {
                type: 'idle',
                until: Date.now() + 10000,
                reason: `Can cok dusuk (${observation.health}/20); tehdit yokken iyiles`
            };
        }

        return null;
    }

    selectThreat(observation, recentDamage) {
        const mobs = observation.hostileMobs || [];
        if (mobs.length === 0) return null;

        return [...mobs]
            .map(mob => ({
                ...mob,
                score: this.threatScore(mob, recentDamage)
            }))
            .sort((a, b) => b.score - a.score)[0] || null;
    }

    threatScore(mob, recentDamage) {
        const profile = this.profile(mob.name);
        const distance = Number(mob.distance) || 0;
        const proximity = Math.max(0, profile.safeDistance - distance) * 8;
        const recentAttackerBonus =
            recentDamage && mob.id === this.recentAttackerId ? 80 : 0;
        return profile.severity + proximity + recentAttackerBonus;
    }

    mustAvoid(threat, profile, observation, capabilities) {
        if (profile.avoid) return true;
        if (!capabilities.hasWeapon && profile.needsWeapon) {
            return threat.distance <= profile.safeDistance + 2 ||
                (
                    observation.isNight &&
                    !this.memory?.data.shelter &&
                    threat.distance <= profile.safeDistance + 10
                ) ||
                this.wasRecentlyDamaged(6000);
        }
        if (observation.health <= this.fleeHealth(profile, capabilities)) return true;
        if (observation.food <= 4 && threat.distance <= profile.safeDistance) return true;
        if (
            observation.isNight &&
            !this.memory?.data.shelter &&
            !capabilities.hasWeapon &&
            threat.distance <= profile.safeDistance + 3
        ) {
            return true;
        }
        return false;
    }

    canFight(threat, profile, observation, capabilities) {
        if (profile.avoid) return false;
        if (profile.needsWeapon && !capabilities.hasWeapon) return false;
        if (observation.health <= this.fleeHealth(profile, capabilities)) return false;
        if (threat.distance > profile.safeDistance + 2 && !this.wasRecentlyDamaged(6000)) {
            return false;
        }
        return true;
    }

    closeRangedFightAction(observation, threat, profile, capabilities) {
        if (profile.kind !== 'ranged') return null;
        const pointBlankShelter =
            !capabilities.hasWeapon &&
            threat.distance <= 1.5 &&
            this.isInsideShelter(observation);
        if (!capabilities.hasWeapon && !pointBlankShelter) return null;
        if (observation.health < 10 && !pointBlankShelter) return null;
        if (threat.distance > 7) return null;

        const action = {
            type: 'fight',
            targetId: threat.id,
            threat: threat.name,
            reason: `${threat.name} cok yakin; kacmak yerine baski kur`
        };
        if (pointBlankShelter) {
            action.standGround = true;
            action.allowUnarmed = true;
        }
        return action;
    }

    defensiveBarricadeAction(observation, threat, profile, capabilities) {
        const shelter = this.memory?.data.shelter || this.memory?.data.base;
        if (!shelter) return null;
        const pointBlankRanged =
            profile.kind === 'ranged' &&
            threat.distance <= 4;
        if (this.memory?.data.shelterBarricaded && !pointBlankRanged) return null;
        if (capabilities.emergencyBlocks < (pointBlankRanged ? 1 : 2)) return null;
        if (observation.health > 8 && !pointBlankRanged) return null;
        if (!['ranged', 'melee_fast', 'melee'].includes(profile.kind)) return null;
        if (threat.distance > 14 && !this.wasRecentlyDamaged(6000)) return null;

        const position = this.bot?.entity?.position;
        if (!position?.distanceTo) return null;
        const distanceToShelter = position.distanceTo(
            new Vec3(shelter.x, shelter.y, shelter.z)
        );
        if (distanceToShelter > 16) return null;

        return {
            type: 'barricade_shelter',
            targetId: threat.id,
            threat: threat.name,
            reason: `Can kritik (${observation.health}/20); base yakininda savunmaya kapan`
        };
    }

    shelterLastStandAction(observation, threat, profile, capabilities, recentDamage) {
        if (!recentDamage) return null;
        if (!this.isInsideShelter(observation)) return null;
        if (!capabilities.hasWeapon) return null;
        if (profile.avoid) return null;
        if (observation.health <= 6) return null;
        if (threat.distance > profile.safeDistance + 3) return null;

        return {
            type: 'fight',
            targetId: threat.id,
            threat: threat.name,
            standGround: true,
            reason: `${threat.name} barinaga vurdu; iceride karsilik ver`
        };
    }

    corneredFightAction(observation, threat, profile, capabilities) {
        if (!this.isInsideShelter(observation)) return null;
        if (!capabilities.hasWeapon) return null;
        if (profile.avoid) return null;
        if (threat.distance > 3.5) return null;

        return {
            type: 'fight',
            targetId: threat.id,
            threat: threat.name,
            standGround: true,
            reason: `${threat.name} cok yakin; barinak icinde kacmak yerine savas`
        };
    }

    lastChanceMeleeFightAction(observation, threat, profile, capabilities) {
        if (!capabilities.hasWeapon) return null;
        if (profile.avoid) return null;
        if (!['melee', 'melee_fast', 'swarm'].includes(profile.kind)) return null;
        if (threat.distance > 3.25) return null;
        if (!this.wasRecentlyDamaged(9000)) return null;
        if (observation.health > this.fleeHealth(profile, capabilities)) return null;

        return {
            type: 'fight',
            targetId: threat.id,
            threat: threat.name,
            standGround: true,
            reason: `${threat.name} cok yakin; kacarken hasar aliyor, karsilik ver`
        };
    }

    emergencyShelterAction(observation, threat, profile, capabilities) {
        if (!observation.isNight) return null;
        if (this.memory?.data.shelter) return null;
        if (profile.avoid) return null;
        if (!capabilities.hasWeapon && threat.distance <= profile.safeDistance + 10) {
            return null;
        }
        const minDistance = observation.health <= 12
            ? Math.max(12, profile.safeDistance + 5)
            : 8;
        if (threat.distance < minDistance) return null;
        if (this.bot?.entity?.position?.y < 1) return null;
        if (capabilities.emergencyBlocks < 2) return null;

        return {
            type: 'emergency_shelter',
            targetId: threat.id,
            threat: threat.name,
            reason: 'Ilk gece acikta kalindi; tehdit uzaktayken siper kur'
        };
    }

    barricadeAction(observation, threat, profile, capabilities) {
        const shelter = this.memory?.data.shelter;
        if (!observation.isNight || !shelter) return null;
        if (this.memory?.data.shelterBarricaded) return null;
        if (profile.kind === 'explosive') return null;
        if (observation.health <= 10) return null;
        if (capabilities.emergencyBlocks < 2) return null;
        if (!this.bot?.entity?.position?.distanceTo) return null;

        const distanceToShelter = this.bot.entity.position.distanceTo(
            new Vec3(shelter.x, shelter.y, shelter.z)
        );
        if (distanceToShelter > 48) return null;

        return {
            type: 'barricade_shelter',
            targetId: threat.id,
            threat: threat.name,
            reason: 'Gece tehdidi; barinaga gir ve girisi kapat'
        };
    }

    fleeAction(threat, observation, profile) {
        if (observation.health <= this.fleeHealth(profile, this.capabilities(observation))) {
            this.escapeUntil = Math.max(this.escapeUntil, Date.now() + 8000);
        }

        return {
            type: 'flee',
            targetId: threat.id,
            threat: threat.name,
            distance: threat.distance,
            reason: observation.health <= this.fleeHealth(profile, this.capabilities(observation))
                ? `Can kritik: ${observation.health}/20`
                : `${threat.name} ile yakin savas riskli`
        };
    }

    fleeHealth(profile, capabilities) {
        if (!capabilities.hasWeapon) return 14;
        if (profile.kind === 'swarm') return 12;
        if (profile.kind === 'melee_fast') return 12;
        if (profile.kind === 'melee') return 10;
        return 14;
    }

    capabilities(observation) {
        const items = this.bot?.inventory?.items?.() || [];
        return {
            hasWeapon: items.some(item =>
                item.name.endsWith('_sword') ||
                item.name.endsWith('_axe')
            ),
            weaponTier: this.bestWeaponTier(items),
            armorScore: this.armorScore(),
            emergencyBlocks: this.countEmergencyBuildBlocks(observation)
        };
    }

    bestWeaponTier(items) {
        const tiers = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'];
        return items
            .filter(item =>
                item.name.endsWith('_sword') ||
                item.name.endsWith('_axe')
            )
            .map(item => tiers.findIndex(tier => item.name.startsWith(`${tier}_`)))
            .reduce((best, rank) => Math.max(best, rank), -1);
    }

    armorScore() {
        const slots = this.bot?.inventory?.slots || [];
        const pieces = [slots[5], slots[6], slots[7], slots[8]].filter(Boolean);
        const tierScore = name => {
            if (name.startsWith('leather_')) return 1;
            if (name.startsWith('golden_')) return 2;
            if (name.startsWith('chainmail_')) return 3;
            if (name.startsWith('iron_')) return 4;
            if (name.startsWith('diamond_')) return 5;
            if (name.startsWith('netherite_')) return 6;
            return 0;
        };
        return pieces.reduce((total, piece) => total + tierScore(piece.name), 0);
    }

    countEmergencyBuildBlocks(observation) {
        const items = observation.inventory?.items || {};
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
        if (this.isInsideShelter(observation)) return false;
        if (this.hasOpenSky()) return false;

        const y =
            observation.position?.y ??
            this.bot?.entity?.position?.y;
        if (y == null) return false;

        const referenceY =
            this.memory?.data.base?.y ??
            this.memory?.data.shelter?.y ??
            this.memory?.data.surfaceAnchor?.y ??
            this.memory?.data.home?.y;
        if (referenceY == null) return false;

        return y <= Math.max(1, referenceY) - 1;
    }

    hasOpenSky() {
        const position = this.bot?.entity?.position;
        if (!position?.offset || !this.bot?.blockAt) return false;

        for (let dy = 1; dy <= 16; dy++) {
            const block = this.bot.blockAt(position.offset(0, dy, 0));
            if (!block) return false;
            if (
                block.boundingBox === 'block' &&
                !block.name.endsWith('_leaves') &&
                block.name !== 'vine'
            ) {
                return false;
            }
        }

        return true;
    }

    isInsideShelter(observation = {}) {
        const shelter = this.memory?.data.shelter || this.memory?.data.base;
        const source = observation.position || this.bot?.entity?.position;
        if (!shelter || !source) return false;

        const position = source.distanceTo
            ? source
            : new Vec3(source.x, source.y, source.z);

        return position.distanceTo(
            new Vec3(shelter.x, shelter.y, shelter.z)
        ) <= 5;
    }

    wasRecentlyDamaged(windowMs) {
        return Date.now() - this.recentDamageAt < windowMs;
    }

    canSeeThreat(threat) {
        const target = threat?.id != null
            ? this.bot?.entities?.[threat.id]
            : null;
        if (!target) return true;
        if (typeof this.bot?.canSeeEntity !== 'function') return true;
        return this.bot.canSeeEntity(target);
    }

    profile(name) {
        return THREAT_PROFILES[name] || DEFAULT_PROFILE;
    }
}

module.exports = CombatSurvival;
