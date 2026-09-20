// ══════════════════════════════════════════
//  cogs/verification_sync.js - Name Based Edition
//  Developed by iam.alpha, Founder of UltraCodeSpace Group
// ══════════════════════════════════════════

import { Events } from 'discord.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const dataDir = process.env.DATA_DIR || '.';
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const DB_PATH = join(dataDir, 'verification_data.db');
const db = new Database(DB_PATH);

db.exec(`CREATE TABLE IF NOT EXISTS frozen_roles (user_id TEXT, guild_id TEXT, roles TEXT, PRIMARY KEY (user_id, guild_id))`);

// 📝 اكتب اسم الرتبة هنا بالضبط كما هي في السيرفر
const UNVERIFIED_ROLE_NAME = 'Unverified';

export async function setup(client) {
    console.log(`🚀 [Sync System] Monitoring role: "${UNVERIFIED_ROLE_NAME}"`);

    client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
        const guild = newMember.guild;

        // البحث عن الرتبة بالاسم
        const unverifiedRole = guild.roles.cache.find(r => r.name === UNVERIFIED_ROLE_NAME);

        if (!unverifiedRole) {
            console.error(`❌ [Critical] لم أجد رتبة باسم "${UNVERIFIED_ROLE_NAME}" في السيرفر!`);
            return;
        }

        const hadUnverified = oldMember.roles.cache.has(unverifiedRole.id);
        const hasUnverified = newMember.roles.cache.has(unverifiedRole.id);

        // منع التكرار إذا لم يحدث تغيير في رتبة Unverified
        if (hadUnverified === hasUnverified) return;

        // --- حالة التجميد (أخذ الرتبة) ---
        if (!hadUnverified && hasUnverified) {
            console.log(`🔍 [Freeze] ${newMember.user.tag} حصل على رتبة ${UNVERIFIED_ROLE_NAME}`);

            const rolesToFreeze = newMember.roles.cache
                .filter(r => r.id !== guild.id && r.id !== unverifiedRole.id && !r.managed)
                .map(r => r.id);

            if (rolesToFreeze.length > 0) {
                db.prepare('INSERT OR REPLACE INTO frozen_roles (user_id, guild_id, roles) VALUES (?, ?, ?)')
                  .run(newMember.id, guild.id, JSON.stringify(rolesToFreeze));

                try {
                    // سحب كل الرتب وإبقاء Unverified فقط
                    await newMember.roles.set([unverifiedRole.id], 'Alpha System: Auto Freeze');
                    console.log(`✅ [SUCCESS] تم تجميد رتب ${newMember.user.tag}`);
                } catch (err) {
                    console.error(`❌ [ERROR] فشل السحب: ${err.message}`);
                }
            }
        }

        // --- حالة الاستعادة (إزالة الرتبة) ---
        if (hadUnverified && !hasUnverified) {
            console.log(`🔍 [Restore] أُزيلت رتبة ${UNVERIFIED_ROLE_NAME} من ${newMember.user.tag}`);

            const data = db.prepare('SELECT roles FROM frozen_roles WHERE user_id = ? AND guild_id = ?')
                           .get(newMember.id, guild.id);

            if (data) {
                const rolesToRestore = JSON.parse(data.roles);
                try {
                    await newMember.roles.add(rolesToRestore, 'Alpha System: Auto Restore');
                    db.prepare('DELETE FROM frozen_roles WHERE user_id = ? AND guild_id = ?').run(newMember.id, guild.id);
                    console.log(`✅ [SUCCESS] تم إرجاع رتب ${newMember.user.tag}`);
                } catch (err) {
                    console.error(`❌ [ERROR] فشل الإرجاع: ${err.message}`);
                }
            }
        }
    });
}
