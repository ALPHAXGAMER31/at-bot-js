import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  SlashCommandBuilder,
  PermissionsBitField,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================= DB =================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'roles.sqlite');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS whitelist (guild_id TEXT, user_id TEXT, PRIMARY KEY (guild_id, user_id))`);

const addWL = db.prepare(`INSERT OR IGNORE INTO whitelist VALUES (?, ?)`);
const delWL = db.prepare(`DELETE FROM whitelist WHERE guild_id=? AND user_id=?`);
const getWL = db.prepare(`SELECT user_id FROM whitelist WHERE guild_id=?`);
const checkWL = db.prepare(`SELECT 1 FROM whitelist WHERE guild_id=? AND user_id=?`);

// ================= TEMPLATES =================
const TEMPLATES = {
  mega_community: [
    { name: '👑 | Owner', color: '#FFFF00', permissions: [PermissionsBitField.Flags.Administrator] },
    { name: '🛡️ | Executive', color: '#FF0000', permissions: [PermissionsBitField.Flags.Administrator] },
    { name: '💎 | Manager', color: '#E91E63', permissions: [PermissionsBitField.Flags.ManageGuild, PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.ManageChannels] },
    { name: '⚔️ | Senior Moderator', color: '#FFA500', permissions: [PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.BanMembers, PermissionsBitField.Flags.MuteMembers] },
    { name: '🛡️ | Moderator', color: '#2ECC71', permissions: [PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.KickMembers] },
    { name: '🤝 | Helper', color: '#3498DB', permissions: [PermissionsBitField.Flags.ManageMessages] },
    { name: '🎉 | Event Manager', color: '#9B59B6', permissions: [PermissionsBitField.Flags.MentionEveryone] },
    { name: '🚀 | Server Booster', color: '#F47FFF', permissions: [] },
    { name: '👤 | Member', color: '#95A5A6', permissions: [] }
  ]
};

// ================= COMMAND =================
export const data = new SlashCommandBuilder()
  .setName('roles')
  .setDescription('نظام إدارة الرتب المتكامل بالأزرار')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub => sub.setName('manage').setDescription('فتح لوحة التحكم بالرتب (Buttons UI)'))
  .addSubcommand(sub => 
    sub.setName('view-role')
      .setDescription('تحليل صلاحيات رتبة معينة')
      .addRoleOption(opt => opt.setName('role').setDescription('الرتبة').setRequired(true))
  );

// ================= EXECUTE =================
export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;
  const isOwner = guild.ownerId === interaction.user.id;
  const isWL = checkWL.get(guild.id, interaction.user.id);

  if (!isOwner && !isWL && sub !== 'view-role') {
    return interaction.reply({ content: '❌ خطأ: هذا الأمر للمسؤولين فقط.', ephemeral: true });
  }

  if (sub === 'manage') {
    const embed = new EmbedBuilder()
      .setTitle('🛡️ لوحة التحكم في الرتب')
      .setColor('#FFFF00')
      .setDescription('استخدم الأزرار أدناه لإدارة الهيكلة:')
      .setFooter({ text: `Admin: ${interaction.user.tag}` });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('roles_setup').setLabel('Setup Owner & Staff').setStyle(ButtonStyle.Primary).setEmoji('👑'),
      new ButtonBuilder().setCustomId('roles_wl_list').setLabel('Whitelist List').setStyle(ButtonStyle.Secondary).setEmoji('📜')
    );

    return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  if (sub === 'view-role') {
    const role = interaction.options.getRole('role');
    const perms = role.permissions.toArray();
    const embed = new EmbedBuilder()
      .setTitle(`📊 تحليل رتبة: ${role.name}`)
      .setColor(role.color || '#ffffff')
      .addFields(
        { name: 'اللون', value: `\`${role.hexColor}\``, inline: true },
        { name: 'الترتيب', value: `\`${role.position}\``, inline: true },
        { name: 'الصلاحيات', value: perms.length > 0 ? perms.map(p => `\`${p}\``).join(', ').slice(0, 1024) : 'لا يوجد' }
      );
    return interaction.reply({ embeds: [embed] });
  }
}

// ================= BUTTON HANDLER (INTERNAL) =================
async function handleInteraction(interaction) {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('roles_')) return;

  const { customId, guild, user } = interaction;
  const isOwner = guild.ownerId === user.id;
  const isWL = checkWL.get(guild.id, user.id);

  if (!isOwner && !isWL) {
    return interaction.reply({ content: '❌ لا تملك صلاحية لاستخدام الأزرار.', ephemeral: true });
  }

  if (customId === 'roles_wl_list') {
    const list = getWL.all(guild.id);
    const content = list.map(x => `• <@${x.user_id}>`).join('\n') || 'القائمة فارغة.';
    return interaction.reply({ content: `🛡️ **قائمة المسؤولين:**\n${content}`, ephemeral: true });
  }

  if (customId === 'roles_setup') {
    await interaction.deferReply({ ephemeral: true });
    const rolesToCreate = TEMPLATES.mega_community;
    let results = [];

    const botMember = await guild.members.fetchMe();
    const botRole = botMember.roles.highest;

    for (const r of rolesToCreate) {
      let role = guild.roles.cache.find(x => x.name === r.name);
      if (!role) {
        role = await guild.roles.create({
          name: r.name,
          color: r.color,
          permissions: r.permissions,
          hoist: true,
          reason: 'Auto Setup Roles'
        });
        results.push(`✅ **${r.name}**`);
      } else {
        results.push(`⚠️ **${r.name}** موجودة`);
      }

      // رفع رتبة Owner لأعلى مكان متاح تحت البوت
      if (r.name.includes('Owner') && role.comparePositionTo(botRole) < 0) {
        try { await role.setPosition(botRole.position - 1); } catch (e) {}
      }
    }
    return interaction.editReply(`🚀 تم تجهيز الهيكلة:\n${results.join('\n')}`);
  }
}

// ================= COG SETUP =================
export async function setup(client) {
  // إضافة مستمع للتفاعلات داخل الموديول نفسه لضمان عمل الأزرار
  client.on('interactionCreate', (interaction) => {
    handleInteraction(interaction).catch(err => console.error('Roles Button Error:', err));
  });

  client.slashCommands.set(data.name, { data, execute });
  console.log('✅ [Module] Roles (Buttons UI) Loaded & Event Listener Active');
}
