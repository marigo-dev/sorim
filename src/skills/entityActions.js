function attack(bot, entity, swing = true) {
    if (!entity || !Number.isInteger(entity.id)) {
        throw new Error('Cannot attack an entity without a numeric id');
    }

    if (bot.supportFeature?.('attackUsesOwnPacket')) {
        bot._client.write('attack', { entityId: entity.id });
        if (swing) bot.swingArm();
        return;
    }

    bot.attack(entity, swing);
}

module.exports = { attack };
