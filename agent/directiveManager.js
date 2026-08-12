class DirectiveManager {
    constructor(memory) {
        this.memory = memory;
    }

    current() {
        return this.memory.getDirective?.() || null;
    }

    follow(username, range = 3) {
        return this.memory.setDirective({ type: 'follow', username, range, assignedBy: username });
    }

    guard({ username = null, anchor = null, range = 5, assignedBy = null } = {}) {
        return this.memory.setDirective({ type: 'guard', username, anchor, range, assignedBy });
    }

    stop() {
        this.memory.setDirective(null);
    }

    nextTool(bot, observation) {
        const directive = this.current();
        if (!directive) return null;

        if (directive.type === 'follow') {
            const entity = bot.players?.[directive.username]?.entity;
            if (!entity?.position) {
                return call('wait_safe', { ms: 900 }, `Waiting for ${directive.username} to become visible`);
            }
            const distance = bot.entity?.position?.distanceTo(entity.position) ?? Infinity;
            if (distance <= directive.range) {
                return call('wait_safe', { ms: 550 }, `Holding formation near ${directive.username}`);
            }
            return call('follow_player', {
                username: directive.username,
                range: directive.range,
                durationMs: 1800
            }, `Continuously follow ${directive.username}`);
        }

        if (directive.type === 'guard') {
            const player = directive.username ? bot.players?.[directive.username]?.entity : null;
            const target = player?.position || directive.anchor || observation?.base;
            if (!target) return call('wait_safe', { ms: 900 }, 'Guard post is not visible yet');
            const distance = bot.entity?.position?.distanceTo(target) ?? Infinity;
            if (distance > directive.range) {
                if (player) {
                    return call('follow_player', {
                        username: directive.username,
                        range: Math.max(3, directive.range - 1),
                        durationMs: 1800
                    }, `Return to guarded player ${directive.username}`);
                }
                return call('move_near', {
                    x: target.x,
                    y: target.y,
                    z: target.z,
                    range: directive.range
                }, 'Return to guard post');
            }
            return call('wait_safe', { ms: 800 }, 'Hold guard position and let safety combat react');
        }

        return null;
    }
}

function call(tool, args, reason) {
    return { tool, args, reason };
}

module.exports = DirectiveManager;
