import 'dotenv/config';

// ════════════════════════════════════════════════
//  ⚙️ إعدادات البوت
// ════════════════════════════════════════════════

export const TOKEN = process.env.DISCORD_TOKEN ?? '';

export const OWNER_IDS = process.env.OWNER_IDS
    ? process.env.OWNER_IDS.split(',').map(id => id.trim())
    : [];

export const GUILD_ID = process.env.GUILD_ID
    ? process.env.GUILD_ID.trim()
    : null;

export const MEDIA_ENABLED = process.env.MEDIA_ENABLED === 'true';
