import {
    EmbedBuilder,
    AttachmentBuilder,
    Events,
} from 'discord.js';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import { existsSync, mkdirSync }                 from 'fs';
import { join, dirname }                         from 'path';
import { fileURLToPath }                         from 'url';
import Database                                  from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ════════════════════════════════════════════════
//  🗄️  قاعدة البيانات (better-sqlite3 بدل quick.db)
// ════════════════════════════════════════════════
const dataDir = process.env.DATA_DIR || join(__dirname, '..', 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, 'welcome.db'));

db.exec(`
    CREATE TABLE IF NOT EXISTS welcome (
        guild_id   TEXT PRIMARY KEY,
        channel    TEXT,
        imgchannel TEXT,
        desc       TEXT,
        image      TEXT,
        thumbnail  TEXT
    )
`);

// ─── helpers ───────────────────────────────────
function getRow(guildId) {
    return db.prepare('SELECT * FROM welcome WHERE guild_id = ?').get(guildId) ?? {};
}

function upsert(guildId, field, value) {
    db.prepare(`
        INSERT INTO welcome (guild_id, ${field})
        VALUES (?, ?)
        ON CONFLICT(guild_id) DO UPDATE SET ${field} = excluded.${field}
    `).run(guildId, value);
}

function resetRow(guildId) {
    db.prepare(`
        UPDATE welcome
        SET channel = NULL, desc = NULL, image = NULL, thumbnail = NULL
        WHERE guild_id = ?
    `).run(guildId);
}

// ════════════════════════════════════════════════
//  🖼️  خلفيات الترحيب
// ════════════════════════════════════════════════
const BACKGROUNDS = [
    'https://i.imgur.com/1.jpg',
    'https://i.imgur.com/2.jpg',
    // ← ضع روابطك هنا
];

// ── تسجيل الخطوط ─────────────────────────────
const fontsDir = join(__dirname, '..', 'fonts');

if (existsSync(join(fontsDir, 'Quicksand-SemiBold.ttf'))) {
    GlobalFonts.registerFromPath(
        join(fontsDir, 'Quicksand-SemiBold.ttf'),
        'Quicksand-SemiBold'
    );
}

if (existsSync(join(fontsDir, 'Vampire Wars.ttf'))) {
    GlobalFonts.registerFromPath(
        join(fontsDir, 'Vampire Wars.ttf'),
        'Vampire Wars'
    );
}

// ════════════════════════════════════════════════
//  🎨  إنشاء صورة الترحيب
// ════════════════════════════════════════════════
async function buildWelcomeImage(member) {
    // ── اختيار خلفية عشوائية ──
    const link = BACKGROUNDS[Math.floor(Math.random() * BACKGROUNDS.length)];

    const W = 6912, H = 3456;
    const canvas = createCanvas(W, H);
    const ctx    = canvas.getContext('2d');

    // ── رسم الخلفية ──
    const bg = await loadImage(link);
    ctx.drawImage(bg, 0, 0, W, H);

    // ── جلب أفاتار العضو ──
    const avatarURL = member.user.displayAvatarURL({ extension: 'jpg', size: 1024 });
    const avatar    = await loadImage(avatarURL);

    // ── النصوص ──
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';

    ctx.font = '215px Quicksand-SemiBold';
    ctx.fillText(
        member.user.createdAt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        2655, 1980
    );
    ctx.fillText(member.user.tag, 1920, 1355);
    ctx.fillText(`${member.guild.memberCount}th member`, 2180, 2600);

    ctx.font = '250px Quicksand-SemiBold';
    ctx.fillText(member.guild.name, 1900, 3100);

    // ── صورة دائرية ──
    const cx = 5260, cy = 1714, r = 1120;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatar, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    return canvas.toBuffer('image/png');
}

// ════════════════════════════════════════════════
//  🔧  استبدال التاجات في النص
// ════════════════════════════════════════════════
function replaceTags(text, member) {
    return text
        .replace(/`?\?user`?/g,    member.user.username)
        .replace(/`?\?tag`?/g,     member.user.tag)
        .replace(/`?\?mention`?/g, `<@${member.user.id}>`)
        .replace(/`?\?server`?/g,  member.guild.name)
        .replace(/`?\?rank`?/g,    String(member.guild.memberCount));
}

function replaceThumbnailTags(text, member) {
    return text
        .replace(/`?\?useravatar`?/g,   member.user.displayAvatarURL({ dynamic: true }))
        .replace(/`?\?serveravatar`?/g, member.guild.iconURL({ dynamic: true }) ?? '');
}

// ════════════════════════════════════════════════
//  📋  أوامر Prefix
// ════════════════════════════════════════════════
function hasAdmin(member) {
    return member.permissions.has('Administrator');
}

const prefixCommands = {

    // ── !setwelcomechannel / !sw ──────────────────
    setwelcomechannel: {
        aliases: ['setwelcome', 'sw'],
        execute: async (message, args) => {
            if (!hasAdmin(message.member))
                return message.reply('❌ تحتاج صلاحية Administrator.');

            const channel = message.mentions.channels.first();
            if (!channel) return message.reply('❌ حدد الروم: `!sw #channel`');

            upsert(message.guild.id, 'channel', channel.id);
            message.reply(`✅ رووم الترحيب: ${channel}`);
        }
    },

    // ── !setdescription / !sd ─────────────────────
    setdescription: {
        aliases: ['setdesc', 'sd'],
        execute: async (message, args) => {
            if (!hasAdmin(message.member))
                return message.reply('❌ تحتاج صلاحية Administrator.');

            const text = args.join(' ');
            if (!text || text.length > 1024)
                return message.reply('❌ اكتب وصفاً (أقل من 1024 حرف).');

            upsert(message.guild.id, 'desc', text);

            // معاينة
            const preview = text
                .replace(/`?\?user`?/g,    message.author.username)
                .replace(/`?\?tag`?/g,     message.author.tag)
                .replace(/`?\?mention`?/g, `<@${message.author.id}>`)
                .replace(/`?\?server`?/g,  message.guild.name)
                .replace(/`?\?rank`?/g,    String(message.guild.memberCount));

            message.reply(`✅ الوصف:\n\`\`\`${preview}\`\`\``);
        }
    },

    // ── !setimage / !si ───────────────────────────
    setimage: {
        aliases: ['setimg', 'si'],
        execute: async (message, args) => {
            if (!hasAdmin(message.member))
                return message.reply('❌ تحتاج صلاحية Administrator.');

            const link = args[0];
            if (!link) return message.reply('❌ أرسل رابط الصورة.');

            upsert(message.guild.id, 'image', link);
            message.reply(`✅ صورة الترحيب: \`${link}\``);
        }
    },

    // ── !setthumbnail / !st ───────────────────────
    setthumbnail: {
        aliases: ['setnail', 'st'],
        execute: async (message, args) => {
            if (!hasAdmin(message.member))
                return message.reply('❌ تحتاج صلاحية Administrator.');

            const text = args.join(' ');
            if (!text) return message.reply('❌ أرسل رابطاً أو `?useravatar` / `?serveravatar`.');

            upsert(message.guild.id, 'thumbnail', text);
            message.reply(`✅ الثمبنيل: \`${text}\``);
        }
    },

    // ── !setimagewelcome / !siw ───────────────────
    setimagewelcome: {
        aliases: ['setimgwel', 'siw'],
        execute: async (message, args) => {
            if (!hasAdmin(message.member))
                return message.reply('❌ تحتاج صلاحية Administrator.');

            const channel = message.mentions.channels.first();
            if (!channel) return message.reply('❌ حدد الروم: `!siw #channel`');

            upsert(message.guild.id, 'imgchannel', channel.id);
            message.reply(`✅ رووم صورة الترحيب: ${channel}`);
        }
    },

    // ── !reset ────────────────────────────────────
    reset: {
        aliases: [],
        execute: async (message) => {
            if (!hasAdmin(message.member))
                return message.reply('❌ تحتاج صلاحية Administrator.');

            resetRow(message.guild.id);
            message.reply('✅ تم حذف كل إعدادات الترحيب.');
        }
    },

    // ── !test ────────────────────────────────────
    test: {
        aliases: [],
        execute: async (message, args, client) => {
            const row = getRow(message.guild.id);

            if (!row.channel)   return message.reply('❌ لم يُحدد رووم الترحيب بعد.');
            if (!row.desc)      return message.reply('❌ لم يُحدد وصف الترحيب بعد.');
            if (!row.thumbnail) return message.reply('❌ لم يُحدد ثمبنيل الترحيب بعد.');

            const mes   = replaceTags(row.desc, { user: message.author, guild: message.guild });
            const tnail = replaceThumbnailTags(row.thumbnail, { user: message.author, guild: message.guild });

            const embed = new EmbedBuilder()
                .setTitle(`Welcome to ${message.guild.name}`)
                .setDescription(mes)
                .setImage(row.image ?? null)
                .setThumbnail(tnail)
                .setColor('Random')
                .setFooter({ text: 'هذا اختبار فقط' });

            const ch = client.channels.cache.get(row.channel);
            if (!ch) return message.reply('❌ الروم غير موجود!');

            await ch.send({ embeds: [embed] });
            message.reply('✅ تم إرسال رسالة الاختبار.');
        }
    },

    // ── !testimage / !ti ──────────────────────────
    testimage: {
        aliases: ['ti'],
        execute: async (message) => {
            const wait = await message.reply('⏳ جاري إنشاء الصورة...');

            try {
                const buffer = await buildWelcomeImage(message.member);
                await wait.delete().catch(() => {});
                await message.channel.send({
                    files: [new AttachmentBuilder(buffer, { name: 'welcome.png' })]
                });
            } catch (err) {
                await wait.edit(`❌ فشل إنشاء الصورة: ${err.message}`);
                console.error(err);
            }
        }
    },

    // ── !welcomehelp ──────────────────────────────
    welcomehelp: {
        aliases: ['wh'],
        execute: async (message) => {
            const embed = new EmbedBuilder()
                .setTitle('📖 أوامر الترحيب')
                .setColor(0x5865F2)
                .setDescription([
                    '**الأوامر الأساسية:**',
                    '`!setwelcomechannel #channel` — رووم رسالة الترحيب',
                    '`!setdescription <نص>` — وصف رسالة الترحيب',
                    '`!setthumbnail <رابط>` — الثمبنيل',
                    '`!setimage <رابط>` — الصورة الكبيرة (اختياري)',
                    '`!setimagewelcome #channel` — رووم صورة الترحيب (اختياري)',
                    '`!reset` — حذف كل الإعدادات',
                    '`!test` — اختبار رسالة الترحيب',
                    '`!testimage` — اختبار صورة الترحيب',
                    '',
                    '**التاجات المتاحة في الوصف:**',
                    '`?user` → اسم العضو',
                    '`?tag` → اسم العضو مع التاج',
                    '`?mention` → منشن العضو',
                    '`?server` → اسم السيرفر',
                    '`?rank` → عدد الأعضاء',
                    '',
                    '**التاجات في الثمبنيل:**',
                    '`?useravatar` → أفاتار العضو',
                    '`?serveravatar` → أيقونة السيرفر',
                ].join('\n'))
                .setFooter({ text: 'Welcome System by AT' });

            message.reply({ embeds: [embed] });
        }
    },
};

// ════════════════════════════════════════════════
//  🔌  Setup
// ════════════════════════════════════════════════
export async function setup(client) {

    // ── تسجيل الأوامر في client.commands ──────────
    const aliasMap = new Map(); // alias → commandName

    for (const [name, cmd] of Object.entries(prefixCommands)) {
        client.commands.set(name, {
            execute: (message, args) => cmd.execute(message, args, client)
        });

        for (const alias of (cmd.aliases ?? [])) {
            aliasMap.set(alias, name);
        }
    }

    // ── معالجة الـ aliases في MessageCreate ───────
    client.on(Events.MessageCreate, async (message) => {
        if (message.author.bot)               return;
        if (!message.guild)                   return;
        if (!message.content.startsWith('!')) return;

        const args = message.content.slice(1).trim().split(/\s+/);
        const cmd  = args.shift().toLowerCase();

        // هل هو alias؟
        const realName = aliasMap.get(cmd);
        if (!realName) return; // مش من أوامرنا

        const command = client.commands.get(realName);
        if (!command) return;

        try {
            await command.execute(message, args);
        } catch (err) {
            console.error(`Welcome cmd error (${cmd}):`, err);
            message.reply('❌ حصل خطأ!').catch(() => {});
        }
    });

    // ════════════════════════════════════════════
    //  🎉  guildMemberAdd — رسالة الترحيب
    // ════════════════════════════════════════════
    client.on(Events.GuildMemberAdd, async (member) => {
        const row = getRow(member.guild.id);

        // ── رسالة Embed ──────────────────────────
        if (row.channel && row.desc && row.thumbnail) {
            try {
                const mes   = replaceTags(row.desc, member);
                const tnail = replaceThumbnailTags(row.thumbnail, member);

                const embed = new EmbedBuilder()
                    .setTitle(`Welcome to ${member.guild.name}`)
                    .setDescription(mes)
                    .setImage(row.image ?? null)
                    .setThumbnail(tnail)
                    .setColor('Random');

                const ch = member.guild.channels.cache.get(row.channel);
                if (ch) await ch.send({ embeds: [embed] });

            } catch (err) {
                console.error('Welcome embed error:', err);
            }
        }

        // ── صورة الترحيب ─────────────────────────
        if (row.imgchannel) {
            try {
                const buffer = await buildWelcomeImage(member);
                const ch     = member.guild.channels.cache.get(row.imgchannel);
                if (ch) {
                    await ch.send({
                        files: [new AttachmentBuilder(buffer, { name: 'welcome.png' })]
                    });
                }
            } catch (err) {
                console.error('Welcome image error:', err);
            }
        }
    });

    console.log('  🎉 Welcome Cog loaded');
}
