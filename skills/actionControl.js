function snapshot(bot) {
    return Number(bot.sorimActionVersion || 0);
}

function cancel(bot, reason = 'cancelled') {
    bot.sorimActionVersion = snapshot(bot) + 1;
    bot.sorimCancelReason = reason;
}

function assertActive(bot, version) {
    if (snapshot(bot) !== version) {
        throw new Error(`Action cancelled: ${bot.sorimCancelReason || 'safety override'}`);
    }
}

module.exports = {
    snapshot,
    cancel,
    assertActive
};
