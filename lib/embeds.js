import { EmbedBuilder } from 'discord.js';

export const COLOR_SUCCESS = 0x2ECC71;
export const COLOR_ERROR   = 0xE74C3C;
export const COLOR_INFO    = 0x3498DB;
export const COLOR_WARN    = 0xF39C12;
export const COLOR_PURPLE  = 0x9B59B6;
export const COLOR_DARK    = 0x2C3E50;

export function makeEmbed({ title, description = '', color = COLOR_INFO, user = null, footer = null }) {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description || '\u200b')
        .setColor(color)
        .setTimestamp();

    if (user) {
        embed.setFooter({
            text: footer || `بواسطة ${user.displayName}`,
            iconURL: user.displayAvatarURL()
        });
    } else if (footer) {
        embed.setFooter({ text: footer });
    }
    return embed;
}

export const successEmbed = (t, d = '', u = null) =>
    makeEmbed({ title: `✅ ${t}`, description: d, color: COLOR_SUCCESS, user: u });

export const errorEmbed = (t, d = '', u = null) =>
    makeEmbed({ title: `❌ ${t}`, description: d, color: COLOR_ERROR, user: u });

export const infoEmbed = (t, d = '', u = null) =>
    makeEmbed({ title: `ℹ️ ${t}`, description: d, color: COLOR_INFO, user: u });

export const warnEmbed = (t, d = '', u = null) =>
    makeEmbed({ title: `⚠️ ${t}`, description: d, color: COLOR_WARN, user: u });
