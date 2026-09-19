// cogs/private_categories.js

import {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    OverwriteType,
} from 'discord.js';

import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || '.';
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

// ══════════════════════════════════════════
//              CONFIG
// ══════════════════════════════════════════
const DB_FILE                  = path.join(dataDir, 'private_categories.db');
const MAX_CATEGORIES_PER_USER  = 2;
const INVITE_CODE_LEN          = 6;
const DEFAULT_LOG_CHANNEL_NAME = 'bot-logs';

// ══════════════════════════════════════════
//              COLORS
// ══════════════════════════════════════════
const COLOR_SUCCESS = 0x2ECC71;
const COLOR_ERROR   = 0xE74C3C;
const COLOR_INFO    = 0x3498DB;
const COLOR_WARN    = 0xF39C12;
const COLOR_PURPLE  = 0x9B59B6;

// ══════════════════════════════════════════
//              DATABASE
// ══════════════════════════════════════════
let db;

function initDb() {
    db = new Database(DB_FILE);

    db.exec(`
        CREATE TABLE IF NOT EXISTS private_categories (
            user_id      TEXT,
            guild_id     TEXT,
            category_id  TEXT PRIMARY KEY,
            name         TEXT,
            invite_code  TEXT,
            created_at   TEXT
        )
    `);

    const cols = db.pragma('table_info(private_categories)').map(c => c.name);
    for (const col of ['invite_code', 'created_at']) {
        if (!cols.includes(col)) {
            try { db.exec(`ALTER TABLE private_categories ADD COLUMN ${col} TEXT`); } catch (_) {}
        }
    }

    db.exec(`
        CREATE TABLE IF NOT EXISTS private_logs (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id TEXT,
            user_id  TEXT,
            action   TEXT,
            time     TEXT
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS private_config (
            guild_id       TEXT PRIMARY KEY,
            log_channel_id TEXT
        )
    `);

    console.log('  📦 PrivateCategories → DB initialized');
}

// ══════════════════════════════════════════
//              EMBED HELPERS
// ══════════════════════════════════════════
function makeEmbed({ title, description = '', color = COLOR_INFO, user = null, footer = null }) {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description || '\u200b')
        .setColor(color)
        .setTimestamp();

    if (user) {
        embed.setFooter({
            text: footer || `طلب بواسطة ${user.displayName}`,
            iconURL: user.displayAvatarURL()
        });
    } else if (footer) {
        embed.setFooter({ text: footer });
    }
    return embed;
}

const successEmbed = (title, desc = '', user = null) =>
    makeEmbed({ title: `✅ ${title}`, description: desc, color: COLOR_SUCCESS, user });

const errorEmbed = (title, desc = '', user = null) =>
    makeEmbed({ title: `❌ ${title}`, description: desc, color: COLOR_ERROR, user });

const infoEmbed = (title, desc = '', user = null) =>
    makeEmbed({ title: `ℹ️ ${title}`, description: desc, color: COLOR_INFO, user });

const warnEmbed = (title, desc = '', user = null) =>
    makeEmbed({ title: `⚠️ ${title}`, description: desc, color: COLOR_WARN, user });

// ══════════════════════════════════════════
//              UTILITY FUNCTIONS
// ══════════════════════════════════════════
function genCode(length = INVITE_CODE_LEN) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        code += chars[bytes[i] % chars.length];
    }
    return code;
}

function getLogChannel(guild) {
    const row = db.prepare('SELECT log_channel_id FROM private_config WHERE guild_id=?').get(guild.id);
    if (row?.log_channel_id) {
        const ch = guild.channels.cache.get(row.log_channel_id);
        if (ch?.type === ChannelType.GuildText) return ch;
    }
    return guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && c.name === DEFAULT_LOG_CHANNEL_NAME
    ) || null;
}

async function logAction(guild, user, action) {
    const timeStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    db.prepare('INSERT INTO private_logs (guild_id, user_id, action, time) VALUES (?,?,?,?)')
      .run(guild?.id ?? null, user?.id ?? null, action, timeStr);

    if (guild) {
        const ch = getLogChannel(guild);
        if (ch) {
            try {
                const embed = makeEmbed({
                    title: '📋 سجل عملية',
                    description:
                        `**المستخدم:** ${user ? `<@${user.id}>` : 'غير معروف'}\n` +
                        `**العملية:** ${action}`,
                    color: COLOR_INFO
                });
                embed.setFooter({ text: timeStr });
                await ch.send({ embeds: [embed] });
            } catch (_) {}
        }
    }
}

function userCategoryCount(userId, guildId) {
    const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM private_categories WHERE user_id=? AND guild_id=?'
    ).get(userId, guildId);
    return row?.cnt ?? 0;
}

function ownsCategory(userId, guildId, categoryId) {
    const row = db.prepare(
        'SELECT 1 FROM private_categories WHERE guild_id=? AND category_id=? AND user_id=?'
    ).get(guildId, categoryId, userId);
    return !!row;
}

function getCategoryOwnerId(categoryId) {
    const row = db.prepare('SELECT user_id FROM private_categories WHERE category_id=?').get(categoryId);
    return row?.user_id ?? null;
}

async function ensureRegistered(category) {
    const existing = db.prepare('SELECT 1 FROM private_categories WHERE category_id=?').get(category.id);
    if (existing) return true;

    const guild = category.guild;
    let ownerId = null;

    for (const [, overwrite] of category.permissionOverwrites.cache) {
        if (overwrite.type === OverwriteType.Member) {
            const member = guild.members.cache.get(overwrite.id);
            if (member && category.permissionsFor(member).has(PermissionFlagsBits.ManageChannels)) {
                ownerId = member.id;
                break;
            }
        }
    }

    if (!ownerId && guild.ownerId) ownerId = guild.ownerId;
    if (!ownerId) return false;

    const inviteCode = genCode();
    const createdAt  = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    db.prepare('INSERT OR REPLACE INTO private_categories VALUES (?,?,?,?,?,?)')
      .run(ownerId, guild.id, category.id, category.name, inviteCode, createdAt);

    return true;
}

// ══════════════════════════════════════════
//         CUSTOM IDs
// ══════════════════════════════════════════
const IDs = {
    BTN_CREATE:      'pc_btn_create',
    BTN_JOIN:        'pc_btn_join',
    BTN_MANAGE:      'pc_btn_manage',
    BTN_HISTORY:     'pc_btn_history',
    BTN_HELP:        'pc_btn_help',
    BTN_GET_CODE:    'pc_btn_get_code',
    BTN_ADD_TEXT:    'pc_btn_add_text',
    BTN_ADD_VOICE:   'pc_btn_add_voice',
    BTN_INVITE_MBR:  'pc_btn_invite_mbr',
    BTN_REMOVE_MBR:  'pc_btn_remove_mbr',
    BTN_RENAME_CAT:  'pc_btn_rename_cat',
    BTN_DELETE_CAT:  'pc_btn_delete_cat',
    BTN_CONFIRM_DEL: 'pc_btn_confirm_del',
    BTN_CANCEL_DEL:  'pc_btn_cancel_del',
    BTN_ADMIN_LIST:  'pc_btn_admin_list',
    BTN_ADMIN_LOG:   'pc_btn_admin_log',
    BTN_ADMIN_RESET: 'pc_btn_admin_reset',
    BTN_ADMIN_STATS: 'pc_btn_admin_stats',
    MODAL_CREATE:    'pc_modal_create',
    MODAL_JOIN:      'pc_modal_join',
    MODAL_ADD_CH:    'pc_modal_add_ch',
    MODAL_RENAME:    'pc_modal_rename',
    SEL_CATEGORY:    'pc_sel_category',
    SEL_MEMBER_INV:  'pc_sel_member_inv',
    SEL_MEMBER_REM:  'pc_sel_member_rem',
    SEL_LOG_CH:      'pc_sel_log_ch',
    SEL_RESET_CAT:   'pc_sel_reset_cat',
    INPUT_CAT_NAME:  'pc_input_cat_name',
    INPUT_CODE:      'pc_input_code',
    INPUT_CH_NAME:   'pc_input_ch_name',
    INPUT_NEW_NAME:  'pc_input_new_name',
};

// ══════════════════════════════════════════
//         VIEW BUILDERS
// ══════════════════════════════════════════
function buildMainPanelView() {
    const row0 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDs.BTN_CREATE).setLabel('🏗️ إنشاء كاتيجوري').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(IDs.BTN_JOIN).setLabel('🔑 انضم بكود').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(IDs.BTN_MANAGE).setLabel('⚙️ إدارة كاتيجوريتي').setStyle(ButtonStyle.Secondary),
    );
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDs.BTN_HISTORY).setLabel('📋 سجل عملياتي').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDs.BTN_HELP).setLabel('❓ مساعدة').setStyle(ButtonStyle.Secondary),
    );
    return [row0, row1];
}

function buildCategoryManageView(categoryId) {
    const row0 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${IDs.BTN_GET_CODE}:${categoryId}`).setLabel('🔑 الكود واللينك').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${IDs.BTN_ADD_TEXT}:${categoryId}`).setLabel('📝 شانل نصي').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${IDs.BTN_ADD_VOICE}:${categoryId}`).setLabel('🔊 شانل صوتي').setStyle(ButtonStyle.Success),
    );
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${IDs.BTN_INVITE_MBR}:${categoryId}`).setLabel('➕ إضافة عضو').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${IDs.BTN_REMOVE_MBR}:${categoryId}`).setLabel('➖ إزالة عضو').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${IDs.BTN_RENAME_CAT}:${categoryId}`).setLabel('✏️ إعادة تسمية').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${IDs.BTN_DELETE_CAT}:${categoryId}`).setLabel('🗑️ حذف الكاتيجوري').setStyle(ButtonStyle.Danger),
    );
    return [row0, row1, row2];
}

function buildConfirmDeleteView(categoryId) {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${IDs.BTN_CONFIRM_DEL}:${categoryId}`).setLabel('✅ نعم، احذف').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(IDs.BTN_CANCEL_DEL).setLabel('❌ إلغاء').setStyle(ButtonStyle.Secondary),
    );
    return [row];
}

function buildAdminPanelView() {
    const row0 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDs.BTN_ADMIN_LIST).setLabel('📋 قائمة الكاتيجوريات').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(IDs.BTN_ADMIN_LOG).setLabel('🔧 قناة اللوغ').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(IDs.BTN_ADMIN_RESET).setLabel('🔄 Reset كاتيجوري').setStyle(ButtonStyle.Danger),
    );
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDs.BTN_ADMIN_STATS).setLabel('📊 إحصائيات').setStyle(ButtonStyle.Secondary),
    );
    return [row0, row1];
}

function buildCategorySelectMenu(categories) {
    const options = categories.slice(0, 25).map(cat => ({
        label: cat.name.slice(0, 100),
        value: String(cat.category_id),
        description: (cat.created_at ? `أُنشئ: ${cat.created_at.slice(0, 10)}` : 'غير معروف').slice(0, 100),
    }));
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(IDs.SEL_CATEGORY)
            .setPlaceholder('اختر كاتيجوري لإدارتها...')
            .addOptions(options)
    );
    return [row];
}

function buildLogChannelSelectMenu(guild) {
    const options = [...guild.channels.cache
        .filter(c => c.type === ChannelType.GuildText)
        .values()]
        .slice(0, 25)
        .map(ch => ({ label: `#${ch.name}`.slice(0, 100), value: ch.id }));

    if (options.length === 0) options.push({ label: 'لا توجد قنوات', value: 'none' });

    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(IDs.SEL_LOG_CH)
            .setPlaceholder('اختر قناة اللوغ...')
            .addOptions(options)
    );
    return [row];
}

function buildResetCatSelectMenu(guild) {
    const options = [...guild.channels.cache
        .filter(c => c.type === ChannelType.GuildCategory)
        .values()]
        .slice(0, 25)
        .map(cat => ({ label: cat.name.slice(0, 100), value: cat.id }));

    if (options.length === 0) options.push({ label: 'لا توجد كاتيجوريات', value: 'none' });

    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(IDs.SEL_RESET_CAT)
            .setPlaceholder('اختر كاتيجوري لإعادة تعيينها...')
            .addOptions(options)
    );
    return [row];
}

function buildMemberSelectMenuWithCatId(guild, action, categoryId) {
    const members = [...guild.members.cache.filter(m => !m.user.bot).values()].slice(0, 25);
    const options = members.length > 0
        ? members.map(m => ({
            label: m.displayName.slice(0, 100),
            value: m.id,
            description: m.user.username.slice(0, 100),
        }))
        : [{ label: 'لا يوجد أعضاء', value: 'none' }];

    const customId = `${action === 'invite' ? IDs.SEL_MEMBER_INV : IDs.SEL_MEMBER_REM}:${categoryId}`;
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(customId)
            .setPlaceholder(`اختر عضو ${action === 'invite' ? 'لإضافته' : 'لإزالته'}...`)
            .addOptions(options)
    );
    return [row];
}

// ══════════════════════════════════════════
//         MODAL BUILDERS
// ══════════════════════════════════════════
function buildCreateCategoryModal() {
    return new ModalBuilder()
        .setCustomId(IDs.MODAL_CREATE)
        .setTitle('🏗️ إنشاء كاتيجوري خاص')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(IDs.INPUT_CAT_NAME)
                    .setLabel('اسم الكاتيجوري')
                    .setPlaceholder('مثال: غرفة أصدقائي')
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(2)
                    .setMaxLength(50)
            )
        );
}

function buildJoinModal() {
    return new ModalBuilder()
        .setCustomId(IDs.MODAL_JOIN)
        .setTitle('🔑 انضم لكاتيجوري')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(IDs.INPUT_CODE)
                    .setLabel('Invite Code')
                    .setPlaceholder('مثال: A3B9KZ')
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(INVITE_CODE_LEN)
                    .setMaxLength(INVITE_CODE_LEN)
            )
        );
}

function buildAddChannelModal(chTypeWithCatId) {
    const [chType] = chTypeWithCatId.split('_');
    const typeLabel = chType === 'text' ? 'نصي' : 'صوتي';
    return new ModalBuilder()
        .setCustomId(`${IDs.MODAL_ADD_CH}:${chTypeWithCatId}`)
        .setTitle(`➕ إضافة شانل ${typeLabel}`)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(IDs.INPUT_CH_NAME)
                    .setLabel('اسم الشانل')
                    .setPlaceholder('مثال: gaming-chat')
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(1)
                    .setMaxLength(50)
            )
        );
}

function buildRenameModalWithCatId(categoryId) {
    return new ModalBuilder()
        .setCustomId(`${IDs.MODAL_RENAME}:cat_${categoryId}`)
        .setTitle('✏️ إعادة تسمية كاتيجوري')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(IDs.INPUT_NEW_NAME)
                    .setLabel('الاسم الجديد')
                    .setPlaceholder('أدخل الاسم الجديد')
                    .setStyle(TextInputStyle.Short)
                    .setMinLength(1)
                    .setMaxLength(50)
            )
        );
}

// ══════════════════════════════════════════
//         INTERACTION HANDLERS
// ══════════════════════════════════════════
async function handleCreateCategory(interaction) {
    const name  = interaction.fields.getTextInputValue(IDs.INPUT_CAT_NAME).trim();
    const guild = interaction.guild;
    const user  = interaction.user;

    if (userCategoryCount(user.id, guild.id) >= MAX_CATEGORIES_PER_USER) {
        return interaction.reply({
            embeds: [errorEmbed('وصلت الحد الأقصى', `يمكنك امتلاك **${MAX_CATEGORIES_PER_USER}** كاتيجوريات كحد أقصى.`)],
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const everyoneDeny = [PermissionFlagsBits.ViewChannel];
    const ownerAllow   = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.ManageChannels,
    ];

    let category, textCh, voiceCh;
    try {
        category = await guild.channels.create({
            name,
            type: ChannelType.GuildCategory,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: everyoneDeny },
                { id: user.id, allow: ownerAllow },
            ],
            reason: `Private category for ${user.username}`
        });

        textCh = await guild.channels.create({
            name: '💬text',
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: everyoneDeny },
                { id: user.id, allow: ownerAllow },
            ],
        });

        voiceCh = await guild.channels.create({
            name: '🔊voice',
            type: ChannelType.GuildVoice,
            parent: category.id,
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: everyoneDeny },
                { id: user.id, allow: ownerAllow },
            ],
        });

    } catch (err) {
        return interaction.followUp({
            embeds: [errorEmbed(
                err.code === 50013 ? 'صلاحيات ناقصة' : 'فشل الإنشاء',
                err.code === 50013 ? 'البوت يحتاج صلاحية **Manage Channels**.' : err.message
            )],
            ephemeral: true
        });
    }

    const inviteCode = genCode();
    const createdAt  = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    db.prepare('INSERT INTO private_categories VALUES (?,?,?,?,?,?)')
      .run(user.id, guild.id, category.id, name, inviteCode, createdAt);

    const embed = successEmbed('تم إنشاء الكاتيجوري!', '', user);
    embed.addFields(
        { name: '📁 الكاتيجوري',  value: `**${name}**`,       inline: true },
        { name: '🔑 Invite Code',  value: `\`${inviteCode}\``, inline: true },
        { name: '📝 شانل النص',    value: `<#${textCh.id}>`,   inline: true },
        { name: '🔊 شانل الصوت',   value: voiceCh.name,        inline: true },
        { name: '💡 نصيحة', value: 'شارك الـ **Invite Code** مع أصدقائك ليدخلوا عبر زر **انضم بكود**.', inline: false },
    );

    await interaction.followUp({ embeds: [embed], ephemeral: true });
    await logAction(guild, user, `أنشأ كاتيجوري \`${name}\` (code: ${inviteCode})`);
}

async function handleJoinCategory(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const user  = interaction.user;
    const code  = interaction.fields.getTextInputValue(IDs.INPUT_CODE).trim().toUpperCase();

    const row = db.prepare(
        'SELECT category_id, name FROM private_categories WHERE guild_id=? AND invite_code=?'
    ).get(guild.id, code);

    if (!row) {
        return interaction.followUp({
            embeds: [errorEmbed('كود خاطئ', 'الكود غير موجود أو منتهي.')],
            ephemeral: true
        });
    }

    const category = guild.channels.cache.get(row.category_id);
    if (!category) {
        return interaction.followUp({
            embeds: [errorEmbed('الكاتيجوري غير متاح', 'ربما تم حذفه.')],
            ephemeral: true
        });
    }

    const member = await guild.members.fetch(user.id);
    if (category.permissionsFor(member).has(PermissionFlagsBits.ViewChannel)) {
        return interaction.followUp({
            embeds: [warnEmbed('موجود بالفعل', 'أنت بالفعل داخل هذه الكاتيجوري.')],
            ephemeral: true
        });
    }

    try {
        await category.permissionOverwrites.create(user.id, {
            ViewChannel:  true,
            SendMessages: true,
            Connect:      true,
            Speak:        true,
        });
    } catch (_) {
        return interaction.followUp({
            embeds: [errorEmbed('صلاحيات ناقصة', 'البوت لا يملك صلاحية تعديل الأذونات.')],
            ephemeral: true
        });
    }

    await interaction.followUp({
        embeds: [successEmbed('تم الانضمام!', `دخلت كاتيجوري **${row.name}** بنجاح 🎉`, user)],
        ephemeral: true
    });
    await logAction(guild, user, `انضم لـ \`${row.name}\` بالكود ${code}`);
}

async function handleGetCode(interaction, categoryId) {
    await interaction.deferReply({ ephemeral: true });

    const guild    = interaction.guild;
    const user     = interaction.user;
    const category = guild.channels.cache.get(categoryId);

    if (!category || !ownsCategory(user.id, guild.id, categoryId)) {
        return interaction.followUp({
            embeds: [errorEmbed('ليست كاتيجوريتك')],
            ephemeral: true
        });
    }

    const row  = db.prepare('SELECT invite_code FROM private_categories WHERE category_id=?').get(categoryId);
    const code = row?.invite_code ?? 'غير موجود';

    let link = null;
    const textCh = category.children?.cache?.find(c => c.type === ChannelType.GuildText);
    if (textCh) {
        try {
            const inv = await textCh.createInvite({ maxAge: 0, maxUses: 0, unique: false });
            link = inv.url;
        } catch (_) {}
    }

    const embed = infoEmbed('معلومات الدعوة', '', user);
    embed.addFields(
        { name: '🔑 Invite Code',  value: `\`${code}\``,           inline: false },
        { name: '🔗 Discord Link', value: link ?? 'تعذّر إنشاؤه',  inline: false },
        { name: '💡', value: 'أرسل الكود لصاحبك ليستخدم زر **انضم بكود** في `/panel`', inline: false },
    );

    await interaction.followUp({ embeds: [embed], ephemeral: true });
    await logAction(guild, user, `عرض invite info لـ \`${category.name}\``);
}

async function handleAddChannel(interaction, chType, categoryId) {
    const name     = interaction.fields.getTextInputValue(IDs.INPUT_CH_NAME).trim();
    const guild    = interaction.guild;
    const user     = interaction.user;
    const category = guild.channels.cache.get(categoryId);

    if (!category) {
        return interaction.reply({ embeds: [errorEmbed('الكاتيجوري غير موجود')], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    await ensureRegistered(category);

    if (!ownsCategory(user.id, guild.id, categoryId)) {
        return interaction.followUp({ embeds: [errorEmbed('ليست كاتيجوريتك')], ephemeral: true });
    }

    let ch;
    try {
        ch = await guild.channels.create({
            name,
            type: chType === 'text' ? ChannelType.GuildText : ChannelType.GuildVoice,
            parent: category.id,
        });
    } catch (err) {
        return interaction.followUp({ embeds: [errorEmbed('فشل الإنشاء', err.message)], ephemeral: true });
    }

    const icon    = chType === 'text' ? '📝' : '🔊';
    const mention = chType === 'text' ? `<#${ch.id}>` : `**${ch.name}**`;

    await interaction.followUp({
        embeds: [successEmbed('تم إنشاء الشانل!', `${icon} ${mention} في **${category.name}**`, user)],
        ephemeral: true
    });
    await logAction(guild, user, `أضاف ${chType} channel \`${name}\` في \`${category.name}\``);
}

async function handleRenameCategory(interaction, categoryId) {
    const name     = interaction.fields.getTextInputValue(IDs.INPUT_NEW_NAME).trim();
    const guild    = interaction.guild;
    const user     = interaction.user;
    const category = guild.channels.cache.get(categoryId);

    if (!category) {
        return interaction.reply({ embeds: [errorEmbed('الكاتيجوري غير موجود')], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    await ensureRegistered(category);

    if (!ownsCategory(user.id, guild.id, categoryId)) {
        return interaction.followUp({ embeds: [errorEmbed('ليست كاتيجوريتك')], ephemeral: true });
    }

    const old = category.name;
    await category.setName(name, `Renamed by ${user.username}`);

    db.prepare('UPDATE private_categories SET name=? WHERE category_id=?').run(name, categoryId);

    await interaction.followUp({
        embeds: [successEmbed('تمت إعادة التسمية!', `الاسم الجديد: **${name}**`, user)],
        ephemeral: true
    });
    await logAction(guild, user, `أعاد تسمية كاتيجوري \`${old}\` → \`${name}\``);
}

async function handleDeleteCategory(interaction, categoryId) {
    await interaction.deferReply({ ephemeral: true });

    const guild    = interaction.guild;
    const user     = interaction.user;
    const category = guild.channels.cache.get(categoryId);

    if (!category) {
        return interaction.followUp({ embeds: [errorEmbed('الكاتيجوري غير موجود')], ephemeral: true });
    }

    const name = category.name;

    for (const [, ch] of (category.children?.cache ?? new Map())) {
        try { await ch.delete(); } catch (_) {}
    }

    try {
        await category.delete();
    } catch (err) {
        return interaction.followUp({ embeds: [errorEmbed('فشل الحذف', err.message)], ephemeral: true });
    }

    db.prepare('DELETE FROM private_categories WHERE category_id=?').run(categoryId);

    await interaction.followUp({
        embeds: [successEmbed('تم الحذف!', `تم حذف **${name}**.`, user)],
        ephemeral: true
    });
    await logAction(guild, user, `حذف الكاتيجوري \`${name}\``);
}

async function handleMemberInvite(interaction, categoryId) {
    await interaction.deferReply({ ephemeral: true });

    const memberId = interaction.values[0];
    if (memberId === 'none') {
        return interaction.followUp({ embeds: [warnEmbed('لا يوجد أعضاء')], ephemeral: true });
    }

    const guild    = interaction.guild;
    const user     = interaction.user;
    const category = guild.channels.cache.get(categoryId);
    const member   = guild.members.cache.get(memberId);

    if (!member || !category) {
        return interaction.followUp({ embeds: [errorEmbed('العضو أو الكاتيجوري غير موجود')], ephemeral: true });
    }

    await ensureRegistered(category);

    if (!ownsCategory(user.id, guild.id, categoryId)) {
        return interaction.followUp({ embeds: [errorEmbed('ليست كاتيجوريتك')], ephemeral: true });
    }

    if (category.permissionsFor(member).has(PermissionFlagsBits.ViewChannel)) {
        return interaction.followUp({
            embeds: [warnEmbed('موجود بالفعل', `<@${member.id}> لديه وصول مسبقاً.`)],
            ephemeral: true
        });
    }

    await category.permissionOverwrites.create(member.id, {
        ViewChannel: true, SendMessages: true, Connect: true, Speak: true,
    });

    await interaction.followUp({
        embeds: [successEmbed('تمت الإضافة!', `تم منح <@${member.id}> وصول لـ **${category.name}**`, user)],
        ephemeral: true
    });
    await logAction(guild, user, `أضاف ${member.user.username} لـ \`${category.name}\``);
}

async function handleMemberRemove(interaction, categoryId) {
    await interaction.deferReply({ ephemeral: true });

    const memberId = interaction.values[0];
    if (memberId === 'none') {
        return interaction.followUp({ embeds: [warnEmbed('لا يوجد أعضاء')], ephemeral: true });
    }

    const guild    = interaction.guild;
    const user     = interaction.user;
    const category = guild.channels.cache.get(categoryId);
    const member   = guild.members.cache.get(memberId);

    if (!member || !category) {
        return interaction.followUp({ embeds: [errorEmbed('العضو أو الكاتيجوري غير موجود')], ephemeral: true });
    }

    await ensureRegistered(category);

    if (!ownsCategory(user.id, guild.id, categoryId)) {
        return interaction.followUp({ embeds: [errorEmbed('ليست كاتيجوريتك')], ephemeral: true });
    }

    await category.permissionOverwrites.delete(member.id);

    await interaction.followUp({
        embeds: [successEmbed('تمت الإزالة!', `تم سحب وصول <@${member.id}> من **${category.name}**`, user)],
        ephemeral: true
    });
    await logAction(guild, user, `أزال ${member.user.username} من \`${category.name}\``);
}

async function handleCategorySelect(interaction) {
    const categoryId = interaction.values[0];
    const guild      = interaction.guild;
    const user       = interaction.user;
    const category   = guild.channels.cache.get(categoryId);

    if (!category) {
        return interaction.reply({
            embeds: [errorEmbed('الكاتيجوري غير موجود', 'ربما تم حذفه.')],
            ephemeral: true
        });
    }

    await ensureRegistered(category);

    const children = category.children?.cache ?? new Map();
    const chList   = children.size > 0
        ? [...children.values()].map(c =>
            `${c.type === ChannelType.GuildText ? '📝' : '🔊'} ${c.name}`
          ).join('\n')
        : 'لا يوجد شانلات';

    const embed = infoEmbed(`إدارة: ${category.name}`, `اختر ما تريد فعله بالكاتيجوري **${category.name}**`, user);
    embed.addFields({ name: '📊 الشانلات', value: chList, inline: false });

    await interaction.reply({
        embeds: [embed],
        components: buildCategoryManageView(categoryId),
        ephemeral: true
    });
}

async function handleSetLogChannel(interaction) {
    const chId = interaction.values[0];
    if (chId === 'none') {
        return interaction.reply({ embeds: [errorEmbed('لا توجد قنوات نصية')], ephemeral: true });
    }

    db.prepare('INSERT OR REPLACE INTO private_config (guild_id, log_channel_id) VALUES (?,?)')
      .run(interaction.guild.id, chId);

    const ch = interaction.guild.channels.cache.get(chId);
    await interaction.reply({
        embeds: [successEmbed('تم تعيين قناة اللوغ!', `القناة: ${ch ? `<#${ch.id}>` : chId}`, interaction.user)],
        ephemeral: true
    });
    await logAction(interaction.guild, interaction.user, `عيّن قناة اللوغ → #${ch?.name ?? chId}`);
}

async function handleResetCategory(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const categoryId = interaction.values[0];
    if (categoryId === 'none') {
        return interaction.followUp({ embeds: [errorEmbed('لا توجد كاتيجوريات')], ephemeral: true });
    }

    const guild    = interaction.guild;
    const user     = interaction.user;
    const category = guild.channels.cache.get(categoryId);

    if (!category) {
        return interaction.followUp({ embeds: [errorEmbed('الكاتيجوري غير موجود')], ephemeral: true });
    }

    for (const [, ch] of (category.children?.cache ?? new Map())) {
        try { await ch.delete(); } catch (_) {}
    }

    const ownerId    = getCategoryOwnerId(categoryId);
    const overwrites = [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }];

    if (ownerId) {
        const owner = guild.members.cache.get(ownerId);
        if (owner) {
            overwrites.push({
                id: owner.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.Connect,
                    PermissionFlagsBits.Speak,
                    PermissionFlagsBits.ManageChannels,
                ]
            });
        }
    }

    try {
        await guild.channels.create({ name: '💬text',  type: ChannelType.GuildText,  parent: category.id, permissionOverwrites: overwrites });
        await guild.channels.create({ name: '🔊voice', type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: overwrites });
    } catch (_) {}

    await interaction.followUp({
        embeds: [successEmbed('تمت إعادة التعيين!', `تم إعادة تعيين **${category.name}**`, user)],
        ephemeral: true
    });
    await logAction(guild, user, `أدمن أعاد تعيين \`${category.name}\``);
}

// ══════════════════════════════════════════
//         PANEL HANDLERS
// ══════════════════════════════════════════
async function handleManagePanel(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const user  = interaction.user;
    const guild = interaction.guild;

    const rows = db.prepare(
        'SELECT category_id, name, created_at FROM private_categories WHERE user_id=? AND guild_id=?'
    ).all(user.id, guild.id);

    if (!rows.length) {
        return interaction.followUp({
            embeds: [warnEmbed('لا يوجد كاتيجوريات', 'لم تنشئ أي كاتيجوري بعد. استخدم زر **إنشاء كاتيجوري**.')],
            ephemeral: true
        });
    }

    const embed = infoEmbed('كاتيجوريتك', `لديك **${rows.length}** كاتيجوري — اختر واحدة لإدارتها:`, user);
    await interaction.followUp({ embeds: [embed], components: buildCategorySelectMenu(rows), ephemeral: true });
}

async function handleHistoryPanel(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const user = interaction.user;
    const rows = db.prepare(
        'SELECT action, time FROM private_logs WHERE user_id=? ORDER BY id DESC LIMIT 10'
    ).all(user.id);

    if (!rows.length) {
        return interaction.followUp({ embeds: [infoEmbed('لا يوجد سجل', 'لم تقم بأي عملية بعد.')], ephemeral: true });
    }

    const embed = infoEmbed('آخر 10 عمليات', '', user);
    rows.forEach((r, i) => {
        embed.addFields({
            name: `\`${i + 1}.\` ${(r.time ?? '').slice(0, 10)}`,
            value: (r.action ?? '').slice(0, 200),
            inline: false
        });
    });

    await interaction.followUp({ embeds: [embed], ephemeral: true });
}

async function handleHelpPanel(interaction) {
    const embed = makeEmbed({ title: '📘 دليل استخدام البوت', color: COLOR_PURPLE, user: interaction.user });
    embed.addFields(
        { name: '🏗️ إنشاء كاتيجوري', value: 'اضغط الزر، أدخل الاسم.\nسيُنشأ كاتيجوري خاص مع شانل نصي وصوتي.', inline: false },
        { name: '🔑 الانضمام بكود', value: 'اطلب الكود من المالك واضغط الزر وأدخله.', inline: false },
        { name: '⚙️ إدارة كاتيجوريتي', value: '• 🔑 الكود واللينك\n• 📝🔊 إضافة شانلات\n• ➕➖ إضافة/إزالة أعضاء\n• ✏️ إعادة التسمية\n• 🗑️ حذف الكاتيجوري', inline: false },
        { name: '📌 ملاحظات', value: `• الحد الأقصى: **${MAX_CATEGORIES_PER_USER}** كاتيجوري لكل شخص\n• البوت يحتاج صلاحية **Manage Channels**\n• الأعضاء يُزالون تلقائياً عند مغادرة السيرفر`, inline: false },
    );
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAdminList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;
    const rows  = db.prepare(
        'SELECT category_id, name, user_id, created_at FROM private_categories WHERE guild_id=?'
    ).all(guild.id);

    if (!rows.length) {
        return interaction.followUp({ embeds: [infoEmbed('لا توجد كاتيجوريات مسجلة')], ephemeral: true });
    }

    const embed = infoEmbed(`كاتيجوريات السيرفر (${rows.length})`, '', interaction.user);
    rows.slice(0, 10).forEach(row => {
        const owner = guild.members.cache.get(row.user_id);
        embed.addFields({
            name: `📁 ${row.name}`,
            value: `**المالك:** ${owner ? `<@${owner.id}>` : row.user_id}\n**التاريخ:** ${row.created_at?.slice(0, 10) ?? '—'}\n**ID:** \`${row.category_id}\``,
            inline: true
        });
    });
    if (rows.length > 10) embed.setFooter({ text: `يُعرض 10 من أصل ${rows.length} كاتيجوري` });

    await interaction.followUp({ embeds: [embed], ephemeral: true });
}

async function handleAdminStats(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId   = interaction.guild.id;
    const catCount  = db.prepare('SELECT COUNT(*) as c FROM private_categories WHERE guild_id=?').get(guildId).c;
    const logCount  = db.prepare('SELECT COUNT(*) as c FROM private_logs WHERE guild_id=?').get(guildId).c;
    const userCount = db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM private_categories WHERE guild_id=?').get(guildId).c;

    const embed = infoEmbed('📊 إحصائيات السيرفر', '', interaction.user);
    embed.addFields(
        { name: '📁 الكاتيجوريات',   value: String(catCount),  inline: true },
        { name: '👥 المستخدمون',     value: String(userCount), inline: true },
        { name: '📋 إجمالي السجلات', value: String(logCount),  inline: true },
    );

    await interaction.followUp({ embeds: [embed], ephemeral: true });
}

// ══════════════════════════════════════════
//         MAIN INTERACTION ROUTER
// ══════════════════════════════════════════
async function handleComponentInteraction(interaction) {
    try {
        // ── Modals ──
        if (interaction.isModalSubmit()) {
            const [base, param] = interaction.customId.split(':');

            if (base === IDs.MODAL_CREATE) return await handleCreateCategory(interaction);
            if (base === IDs.MODAL_JOIN)   return await handleJoinCategory(interaction);

            if (base === IDs.MODAL_ADD_CH) {
                const underscoreIdx = param.indexOf('_');
                const chType        = param.slice(0, underscoreIdx);
                const categoryId    = param.slice(underscoreIdx + 1);
                return await handleAddChannel(interaction, chType, categoryId);
            }

            if (base === IDs.MODAL_RENAME) {
                const categoryId = param.slice(param.indexOf('_') + 1);
                return await handleRenameCategory(interaction, categoryId);
            }
            return;
        }

        // ── Buttons ──
        if (interaction.isButton()) {
            const colonIdx = interaction.customId.indexOf(':');
            const base     = colonIdx >= 0 ? interaction.customId.slice(0, colonIdx) : interaction.customId;
            const param    = colonIdx >= 0 ? interaction.customId.slice(colonIdx + 1) : null;

            if (base === IDs.BTN_CREATE)     return await interaction.showModal(buildCreateCategoryModal());
            if (base === IDs.BTN_JOIN)       return await interaction.showModal(buildJoinModal());
            if (base === IDs.BTN_MANAGE)     return await handleManagePanel(interaction);
            if (base === IDs.BTN_HISTORY)    return await handleHistoryPanel(interaction);
            if (base === IDs.BTN_HELP)       return await handleHelpPanel(interaction);
            if (base === IDs.BTN_GET_CODE)   return await handleGetCode(interaction, param);
            if (base === IDs.BTN_ADD_TEXT)   return await interaction.showModal(buildAddChannelModal(`text_${param}`));
            if (base === IDs.BTN_ADD_VOICE)  return await interaction.showModal(buildAddChannelModal(`voice_${param}`));

            if (base === IDs.BTN_INVITE_MBR) {
                return interaction.reply({
                    embeds: [infoEmbed('اختر عضو لإضافته')],
                    components: buildMemberSelectMenuWithCatId(interaction.guild, 'invite', param),
                    ephemeral: true
                });
            }
            if (base === IDs.BTN_REMOVE_MBR) {
                return interaction.reply({
                    embeds: [infoEmbed('اختر عضو لإزالته')],
                    components: buildMemberSelectMenuWithCatId(interaction.guild, 'remove', param),
                    ephemeral: true
                });
            }
            if (base === IDs.BTN_RENAME_CAT) return await interaction.showModal(buildRenameModalWithCatId(param));
            if (base === IDs.BTN_DELETE_CAT) {
                const cat = interaction.guild.channels.cache.get(param);
                return interaction.reply({
                    embeds: [warnEmbed('تأكيد الحذف', `هل أنت متأكد من حذف **${cat?.name ?? param}** وكل شانلاتها؟`)],
                    components: buildConfirmDeleteView(param),
                    ephemeral: true
                });
            }
            if (base === IDs.BTN_CONFIRM_DEL) return await handleDeleteCategory(interaction, param);
            if (base === IDs.BTN_CANCEL_DEL) {
                return interaction.reply({
                    embeds: [infoEmbed('تم الإلغاء', 'لم يتم حذف أي شيء.')],
                    ephemeral: true
                });
            }
            if (base === IDs.BTN_ADMIN_LIST)  return await handleAdminList(interaction);
            if (base === IDs.BTN_ADMIN_STATS) return await handleAdminStats(interaction);
            if (base === IDs.BTN_ADMIN_LOG) {
                return interaction.reply({
                    embeds: [infoEmbed('اختر قناة اللوغ', 'اختر القناة التي ستستقبل سجلات البوت:', interaction.user)],
                    components: buildLogChannelSelectMenu(interaction.guild),
                    ephemeral: true
                });
            }
            if (base === IDs.BTN_ADMIN_RESET) {
                return interaction.reply({
                    embeds: [infoEmbed('اختر كاتيجوري لإعادة تعيينها')],
                    components: buildResetCatSelectMenu(interaction.guild),
                    ephemeral: true
                });
            }
            return;
        }

        // ── Select Menus ──
        if (interaction.isAnySelectMenu()) {
            const colonIdx = interaction.customId.indexOf(':');
            const base     = colonIdx >= 0 ? interaction.customId.slice(0, colonIdx) : interaction.customId;
            const param    = colonIdx >= 0 ? interaction.customId.slice(colonIdx + 1) : null;

            if (base === IDs.SEL_CATEGORY)   return await handleCategorySelect(interaction);
            if (base === IDs.SEL_MEMBER_INV) return await handleMemberInvite(interaction, param);
            if (base === IDs.SEL_MEMBER_REM) return await handleMemberRemove(interaction, param);
            if (base === IDs.SEL_LOG_CH)     return await handleSetLogChannel(interaction);
            if (base === IDs.SEL_RESET_CAT)  return await handleResetCategory(interaction);
        }

    } catch (err) {
        console.error('  ❌ خطأ في handleComponentInteraction:', err);
        try {
            const payload = { embeds: [errorEmbed('خطأ غير متوقع', err.message)], ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(payload);
            } else {
                await interaction.reply(payload);
            }
        } catch (_) {}
    }
}

// ══════════════════════════════════════════
//              SLASH COMMANDS
// ══════════════════════════════════════════
const panelCommand = {
    data: new SlashCommandBuilder()
        .setName('panel')
        .setDescription('🎛️ لوحة التحكم — كل وظائف الكاتيجوريات الخاصة'),

    async execute(interaction) {
        try {
            const embed = makeEmbed({
                title: '🎛️ Private Categories — لوحة التحكم',
                description:
                    'مرحباً! اختر ما تريد:\n\n' +
                    '**🏗️ إنشاء كاتيجوري** — أنشئ مجموعتك الخاصة\n' +
                    '**🔑 انضم بكود** — انضم لمجموعة صاحبك\n' +
                    '**⚙️ إدارة كاتيجوريتي** — أدِر مجموعاتك الحالية\n' +
                    '**📋 سجل عملياتي** — آخر نشاطاتك\n' +
                    '**❓ مساعدة** — دليل الاستخدام',
                color: COLOR_PURPLE,
                user: interaction.user,
            });

            if (interaction.guild.iconURL()) embed.setThumbnail(interaction.guild.iconURL());
            embed.setFooter({
                text: `السيرفر: ${interaction.guild.name}`,
                iconURL: interaction.guild.iconURL() ?? undefined,
            });

            await interaction.reply({ embeds: [embed], components: buildMainPanelView(), ephemeral: true });
        } catch (err) {
            console.error(err);
            const payload = { embeds: [errorEmbed('خطأ', err.message)], ephemeral: true };
            if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
            else await interaction.reply(payload).catch(() => {});
        }
    }
};

const adminCommand = {
    data: new SlashCommandBuilder()
        .setName('admin')
        .setDescription('🛠️ لوحة تحكم الأدمن — إدارة الكاتيجوريات والإعدادات')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        try {
            const embed = makeEmbed({
                title: '🛠️ Admin Control Panel',
                description:
                    'لوحة تحكم المسؤول — اختر العملية:\n\n' +
                    '**📋 قائمة الكاتيجوريات** — كل الكاتيجوريات المسجلة\n' +
                    '**🔧 قناة اللوغ** — اختر قناة لتسجيل العمليات\n' +
                    '**🔄 Reset كاتيجوري** — إعادة تعيين شانلات كاتيجوري\n' +
                    '**📊 إحصائيات** — إحصائيات عامة',
                color: COLOR_WARN,
                user: interaction.user,
                footer: 'Admin Only',
            });

            await interaction.reply({ embeds: [embed], components: buildAdminPanelView(), ephemeral: true });
        } catch (err) {
            console.error(err);
            const payload = { embeds: [errorEmbed('خطأ', err.message)], ephemeral: true };
            if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
            else await interaction.reply(payload).catch(() => {});
        }
    }
};

// ══════════════════════════════════════════
//              SETUP FUNCTION
// ══════════════════════════════════════════
export async function setup(client) {
    initDb();

    client.slashCommands.set('panel', panelCommand);
    client.slashCommands.set('admin', adminCommand);

    // ── guildCreate محذوف نهائياً ──

    client.on('guildMemberRemove', async (member) => {
        const guild = member.guild;
        for (const [, cat] of guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory)) {
            try {
                if (cat.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
                    await cat.permissionOverwrites.delete(member.id);
                    await logAction(guild, null, `أُزيلت أذونات ${member.user.username} تلقائياً من \`${cat.name}\` بعد خروجه`);
                }
            } catch (_) {}
        }
    });

    client.on('componentInteraction', handleComponentInteraction);

    console.log('  ✅ PrivateCategories Cog → loaded');
}
