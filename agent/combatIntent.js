function parseCombatIntent(message, speaker, onlineUsernames = []) {
    const text = fold(message);
    const hasCombatVerb = /\b(savas|saldir|oldur|fight|attack|kill)\b/.test(text);
    if (!hasCombatVerb) return null;

    const lethal = /\b(oldur|kill)\b/.test(text) ||
        /\b(olene kadar|to the death|until (?:i|they|he|she) die)\b/.test(text);
    const selfTarget = /\b(benimle savas|bana saldir|beni oldur|fight me|attack me|kill me)\b/.test(text) ||
        (/\bolene kadar\b/.test(text) && /\bbenimle|bana|beni\b/.test(text));

    if (!selfTarget) {
        const targetMob = findMobTarget(text);
        if (targetMob !== undefined) {
            return { intent: 'combat_mob', targetMob, combatMode: 'lethal' };
        }
    }

    let targetPlayer = selfTarget ? speaker : findMentionedPlayer(text, onlineUsernames, speaker);
    if (!targetPlayer) targetPlayer = extractNamedTarget(text);
    if (!targetPlayer) return null;

    return {
        intent: 'combat',
        targetPlayer,
        combatMode: lethal ? 'lethal' : 'duel'
    };
}

function findMobTarget(text) {
    const aliases = {
        zombie: ['zombie', 'zombi'],
        skeleton: ['skeleton', 'iskelet'],
        creeper: ['creeper'],
        spider: ['spider', 'orumcek'],
        cave_spider: ['cave spider', 'magara orumcegi'],
        witch: ['witch', 'cadi'],
        enderman: ['enderman'],
        drowned: ['drowned', 'bogulmus'],
        husk: ['husk'],
        stray: ['stray'],
        slime: ['slime'],
        pillager: ['pillager', 'yagmaci'],
        vindicator: ['vindicator'],
        ravager: ['ravager'],
        phantom: ['phantom'],
        blaze: ['blaze'],
        piglin: ['piglin'],
        hoglin: ['hoglin']
    };
    for (const [name, names] of Object.entries(aliases)) {
        if (names.some(alias => new RegExp(
            `(^|[^a-z0-9_])${escapeRegExp(alias)}(?:yi|i|ye|ya|yle|la)?([^a-z0-9_]|$)`
        ).test(text))) {
            return name;
        }
    }
    if (/\b(su yaratik(?:la|i)?|bu yaratik(?:la|i)?|yaratigi|canavari|hostile mob|this mob|that mob)\b/.test(text)) return null;
    return undefined;
}

function findMentionedPlayer(text, onlineUsernames, speaker) {
    return (onlineUsernames || []).find(username => {
        if (!username || username.toLowerCase() === String(speaker || '').toLowerCase()) return false;
        const name = escapeRegExp(fold(username));
        return new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`, 'i').test(text);
    }) || null;
}

function extractNamedTarget(text) {
    const ambiguous = new Set([
        'onu', 'bunu', 'sunu', 'birini', 'hedefi', 'oyuncuyu',
        'it', 'them', 'someone', 'somebody', 'target', 'player'
    ]);
    const patterns = [
        /\b(?:oldur|kill|saldir|attack)\s+([a-z0-9_]{3,16})\b/,
        /\b([a-z0-9_]{3,16})(?:\s+oyuncusunu|\s+oyuncuya)?\s+(?:oldur|kill|saldir|attack)\b/
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && !ambiguous.has(match[1])) return match[1];
    }
    return null;
}

function fold(value) {
    return String(value || '').toLocaleLowerCase('tr-TR')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ı/g, 'i');
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { parseCombatIntent, findMobTarget };
