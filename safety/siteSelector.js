const { Vec3 } = require('vec3');
const blockPolicy = require('./blockPolicy');

const BUILDABLE_FLOORS = new Set([
    'grass_block', 'dirt', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium',
    'pale_moss_block', 'moss_block', 'stone', 'andesite', 'diorite', 'granite',
    'deepslate', 'tuff', 'calcite', 'sand', 'red_sand', 'gravel', 'clay', 'mud'
]);

function findBuildSite(bot, options = {}) {
    const origin = bot.entity.position.floored();
    const radius = Math.max(4, Number(options.radius || 14));
    const width = Math.max(3, Number(options.width || 5));
    const depth = Math.max(3, Number(options.depth || 5));
    const maxVerticalDelta = Math.max(0, Number(options.maxVerticalDelta ?? 2));
    const candidates = [];

    for (let x = -radius; x <= radius; x += 3) {
        for (let z = -radius; z <= radius; z += 3) {
            const center = surfaceNear(bot, origin.offset(x, 0, z));
            if (!center || blockPolicy.protectedZoneAt(center)) continue;
            if (Math.abs(center.y - origin.y) > maxVerticalDelta) continue;
            const assessment = assessFootprint(bot, center, width, depth, options);
            if (!assessment.valid) continue;
            candidates.push({ position: center, ...assessment });
        }
    }

    candidates.sort((left, right) => right.score - left.score);
    return candidates[0] || null;
}

function assessFootprint(bot, center, width, depth, options = {}) {
    const heights = [];
    let hazards = 0;
    let occupied = 0;
    const halfWidth = Math.floor(width / 2);
    const halfDepth = Math.floor(depth / 2);

    for (let x = -halfWidth; x <= halfWidth; x++) {
        for (let z = -halfDepth; z <= halfDepth; z++) {
            const surface = surfaceNear(bot, center.offset(x, 0, z), 5);
            if (!surface) return { valid: false, score: 0 };
            heights.push(surface.y);
            const floor = bot.blockAt(surface.offset(0, -1, 0));
            if (!BUILDABLE_FLOORS.has(floor?.name)) {
                return { valid: false, score: 0 };
            }
            if (['water', 'lava'].includes(floor?.name)) hazards++;
            for (let y = 0; y <= 3; y++) {
                const block = bot.blockAt(new Vec3(surface.x, surface.y + y, surface.z));
                if (block && block.boundingBox !== 'empty' && !isReplaceable(block.name)) occupied++;
            }
        }
    }

    const variation = Math.max(...heights) - Math.min(...heights);
    const terraform = heights.reduce((sum, height) => sum + Math.abs(height - center.y), 0) + occupied;
    const maxTerrainVariation = Math.max(0, Number(options.maxTerrainVariation ?? 2));
    const maxTerraformBlocks = Math.max(0, Number(options.maxTerraformBlocks ?? width * depth));
    const valid = hazards === 0 && variation <= maxTerrainVariation && terraform <= maxTerraformBlocks;
    const distance = center.distanceTo(bot.entity.position);
    const verticalDistance = Math.abs(center.y - bot.entity.position.y);
    const score = 100 - variation * 25 - terraform * 2 - distance * 0.25 - verticalDistance * 12;
    return { valid, score, variation, terraformBlocks: terraform, hazards };
}

function surfaceNear(bot, position, verticalRange = 8) {
    for (let offset = verticalRange; offset >= -verticalRange; offset--) {
        const feet = new Vec3(position.x, position.y + offset, position.z);
        const floor = bot.blockAt(feet.offset(0, -1, 0));
        const body = bot.blockAt(feet);
        const head = bot.blockAt(feet.offset(0, 1, 0));
        if (
            floor?.boundingBox === 'block' &&
            BUILDABLE_FLOORS.has(floor.name) &&
            passable(body) &&
            passable(head)
        ) return feet;
    }
    return null;
}

function passable(block) {
    return !block || block.boundingBox === 'empty' || ['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass'].includes(block.name);
}

function isReplaceable(name) {
    return ['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass', 'snow'].includes(name);
}

module.exports = { findBuildSite, assessFootprint };
