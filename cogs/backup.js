// ══════════════════════════════════════════
//  cogs/backup.js
//  باك أب يومي على الخاص + /export + /import + /restart
//  Developed by iam.alpha, Founder of UltraCodeSpace Group
// ══════════════════════════════════════════

import {
    SlashCommandBuilder,
    PermissionFlagsBits,
} from 'discord.js';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { gzipSync, gunzipSync } from 'zlib';

const ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR || '.';
const BASE = DATA_DIR === '.' ? ROOT : DATA_DIR;
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_BACKUP_MS    = 2  * 60 * 1000;

// ── جمع ملفات الإعدادات (الداتابيز + welcome_settings.json) ──
function collectStateFiles() {
    const files = new Set();
    const scan = (dir) => {
        if (!existsSync(dir)) return;
        for (const f of readdirSync(dir)) {
            const p = join(dir, f);
            if (
                f.endsWith('.db')         ||
                f.endsWith('.sqlite')     ||
                f.endsWith('.db-wal')     ||
                f.endsWith('.db-shm')     ||
                f.endsWith('.sqlite-wal') ||
                f.endsWith('.sqlite-shm') ||
                f === 'welcome_settings.json'
            ) {
                files.add(p);
            }
        }
    };
    scan(BASE);
    scan(join(BASE, 'data'));
    return [...files];
}

function exportNameFor(p) {
    return relative(BASE, p).split(/[\\/]/).join('__') + '.gz';
}

function isOwner(interaction) {
    return interaction.client.ownerIds?.has(interaction.user.id) ?? false;
}

// ── إرسال النسخة على الخاص (10 ملفات لكل رسالة) ──
async function sendBackup(user, files, title) {
    const chunks = [];
    for (let i = 0; i < files.length; i += 10) chunks.push(files.slice(i, i + 10));

    let sent = 0;
    const dm = await user.createDM();
    for (let idx = 0; idx < chunks.length; idx++) {
        await dm.send({
            content: `${title} — جزء ${idx + 1}/${chunks.length}`,
            files: chunks[idx].map(p => ({
                attachment: gzipSync(readFileSync(p)),
                name: exportNameFor(p),
            })),
        });
        sent += chunks[idx].length;
    }
    return sent;
}

// ══════════════════════════════════════════
//  /export — تصدير نسخة احتياطية على الخاص
// ══════════════════════════════════════════
const exportCmd = {
    data: new SlashCommandBuilder()
        .setName('export')
        .setDescription('📦 تصدير نسخة احتياطية من كل إعدادات البوت على الخاص')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction, client) {
        if (!isOwner(interaction)) {
            return interaction.reply({ content: '❌ الأمر ده للأونرز فقط', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        const files = collectStateFiles();
        if (!files.length) return interaction.editReply('⚠️ مفيش ملفات إعدادات للتصدير');

        try {
            const sent = await sendBackup(interaction.user, files, '📦 نسخة احتياطية (/export)');
            await interaction.editReply(`✅ تم إرسال النسخة الاحتياطية على الخاص (${sent} ملف)`);
        } catch (err) {
            await interaction.editReply(`❌ فشل الإرسال على الخاص: ${err.message}\nتأكد إن خاصك مفتوح للبوت`);
        }
    },
};

// ══════════════════════════════════════════
//  /import — استيراد نسخة احتياطية
// ══════════════════════════════════════════
const importCmd = {
    data: new SlashCommandBuilder()
        .setName('import')
        .setDescription('📥 استيراد نسخة احتياطية (ارفع ملف .gz من الخاص)')
        .addAttachmentOption(o => o
            .setName('file')
            .setDescription('ملف النسخة الاحتياطية (.gz)')
            .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction, client) {
        if (!isOwner(interaction)) {
            return interaction.reply({ content: '❌ الأمر ده للأونرز فقط', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        const file = interaction.options.getAttachment('file');

        try {
            const res  = await fetch(file.url);
            const raw  = Buffer.from(await res.arrayBuffer());
            let name = file.name;
            let data = raw;
            if (name.endsWith('.gz')) {
                data = gunzipSync(raw);
                name = name.slice(0, -3);
            }

            const segs = name.split('__');
            if (segs.some(s => !s || s === '..')) {
                return interaction.editReply('❌ اسم ملف غير صالح');
            }

            const isStateJson = name === 'welcome_settings.json';
            if (!isStateJson && !/\.db(-wal|-shm)?$|\.sqlite(-wal|-shm)?$/.test(name)) {
                return interaction.editReply('❌ ملف غير معروف (مسموح: .db / .sqlite / welcome_settings.json)');
            }

            const target = join(BASE, ...segs);
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, data);

            await interaction.editReply(`✅ تم استيراد \`${name}\` — استخدم /restart عشان يشتغل`);
        } catch (err) {
            await interaction.editReply(`❌ فشل الاستيراد: ${err.message}`);
        }
    },
};

// ══════════════════════════════════════════
//  /restart — إعادة تشغيل البوت
// ══════════════════════════════════════════
const restartCmd = {
    data: new SlashCommandBuilder()
        .setName('restart')
        .setDescription('🔄 إعادة تشغيل البوت (على Render هيتشغل تلقائياً)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction, client) {
        if (!isOwner(interaction)) {
            return interaction.reply({ content: '❌ الأمر ده للأونرز فقط', ephemeral: true });
        }

        await interaction.reply({ content: '🔄 جاري إعادة التشغيل...', ephemeral: true });
        setTimeout(() => process.exit(0), 1500);
    },
};

// ══════════════════════════════════════════
//  Setup — تسجيل الأوامر + الباك أب اليومي
// ══════════════════════════════════════════
export async function setup(client) {
    if (!client.slashCommands) client.slashCommands = new Map();
    for (const cmd of [exportCmd, importCmd, restartCmd]) {
        client.slashCommands.set(cmd.data.name, cmd);
    }

    const dailyBackup = async () => {
        try {
            const files = collectStateFiles();
            if (!files.length) return;

            for (const ownerId of client.ownerIds ?? []) {
                try {
                    const user = await client.users.fetch(ownerId);
                    await sendBackup(user, files, '📦 باك أب يومي لإعدادات البوت');
                } catch (err) {
                    console.log(`⚠️ [backup] فشل إرسال الباك أب لـ ${ownerId}: ${err.message}`);
                }
            }
            console.log(`📦 [backup] تم إرسال الباك أب اليومي (${files.length} ملف)`);
        } catch (err) {
            console.log(`⚠️ [backup] فشل الباك أب اليومي: ${err.message}`);
        }
    };

    setTimeout(() => {
        dailyBackup();
        setInterval(dailyBackup, BACKUP_INTERVAL_MS);
    }, FIRST_BACKUP_MS);

    console.log('✅ Backup Cog Loaded Successfully.');
}
