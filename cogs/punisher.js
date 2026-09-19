// ══════════════════════════════════════════
//  cogs/punisher.js
//  Developed by iam.alpha, Founder of UltraCodeSpace Group


// ══════════════════════════════════════════

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
  SlashCommandBuilder,
  Events,
} from "discord.js";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join }  from "path";
import { existsSync, mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || ".";
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

// ==========================================
// --- 1. إعداد قاعدة البيانات ---
// ==========================================
const DB_PATH = join(dataDir, "punisher.db");
const db      = new Database(DB_PATH);

function initDb() {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = 10000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS punishments (
      user_id INTEGER, guild_id INTEGER, type TEXT,
      end_time TEXT, admin_id INTEGER, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS warnings (
      user_id INTEGER, guild_id INTEGER, warn_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS bot_owners (
      user_id INTEGER UNIQUE
    );
    CREATE TABLE IF NOT EXISTS punishment_history (
      user_id INTEGER, guild_id INTEGER, type TEXT,
      start_time TEXT, end_time TEXT,
      admin_id INTEGER, reason TEXT, removed_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS log_messages (
      guild_id INTEGER PRIMARY KEY, message_id TEXT, channel_id TEXT
    );
    CREATE TABLE IF NOT EXISTS pardon_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER, guild_id INTEGER,
      punishment_type TEXT, reason TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT, reviewed_by INTEGER, reviewed_at TEXT
    );
  `);
  try {
    const cols = db.pragma("table_info(punishments)").map((r) => r.name);
    if (!cols.includes("reason")) db.exec("ALTER TABLE punishments ADD COLUMN reason TEXT");
  } catch {}
}

initDb();

// ==========================================
// --- 2. الثوابت والكاش ---
// ==========================================
const ROLE_TEXT_BAN  = "🚫・مقيد-كتابي";
const ROLE_VOICE_BAN = "🎙️・مقيد-صوتي";
const ROLE_FULL_BAN  = "🔒・مقيد-كامل";

const settingsCache = new Map();
const CACHE_TTL     = 30 * 1000;
let   BOT_OWNERS    = new Set();
let   lastEventTime = Date.now();

// ==========================================
// --- 3. دوال مساعدة ---
// ==========================================
function getAwareDt(dtStr)      { return new Date(dtStr); }
function invalidateCache(gid)   { settingsCache.delete(gid); }

function updateOwnersCache(client) {
  const envOwners = [...(client.ownerIds || new Set())].map(String);
  const dbOwners  = db.prepare("SELECT user_id FROM bot_owners").all().map((r) => String(r.user_id));
  BOT_OWNERS      = new Set([...envOwners, ...dbOwners]);
  console.log(`  👑 Punisher — الأونرز: [${[...BOT_OWNERS].join(", ") || "لا يوجد"}]`);
}

function isSystemOwner(member) {
  return BOT_OWNERS.has(String(member.id)) || member.id === member.guild.ownerId;
}

function getUserRank(member) {
  if (isSystemOwner(member)) return "OWNER 👑";
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return "إداري🛡️";
  return "مستخدم👤";
}

// ==========================================
// --- 4. دوال القنوات والـ Roles ---
// ==========================================
async function getOrCreateChannel(guild, name, isPrivate = false) {
  let ch = guild.channels.cache.find(
    (c) => c.name === name && c.type === ChannelType.GuildText
  );
  if (!ch) {
    const perms = [];
    if (name === "banned") {
      perms.push({ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ViewChannel] });
    } else if (name === "punisher_logs") {
      perms.push({ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel] });
    } else {
      perms.push({ id: guild.roles.everyone.id, ...(isPrivate ? { deny: [PermissionFlagsBits.ViewChannel] } : { allow: [PermissionFlagsBits.ViewChannel] }) });
    }
    ch = await guild.channels.create({ name, type: ChannelType.GuildText, permissionOverwrites: perms });
  }
  return ch;
}

async function getOrCreateRole(guild, name, options = {}) {
  let role = guild.roles.cache.find((r) => r.name === name);
  if (!role) {
    role = await guild.roles.create({ name, ...options });
    for (const channel of guild.channels.cache.values()) {
      try {
        if (name === ROLE_TEXT_BAN || name === ROLE_FULL_BAN) {
          await channel.permissionOverwrites.create(role, { ViewChannel: false, SendMessages: false });
        } else if (name === ROLE_VOICE_BAN && channel.type === ChannelType.GuildVoice) {
          await channel.permissionOverwrites.create(role, { ViewChannel: false, Connect: false });
        }
      } catch {}
    }
  }
  return role;
}

async function applyLockdown(member, guild) {
  const activeTypes   = db.prepare("SELECT type FROM punishments WHERE user_id=? AND guild_id=?")
    .all(member.id, guild.id).map((r) => r.type);
  const bannedChannel = await getOrCreateChannel(guild, "banned");
  let roleText        = guild.roles.cache.find((r) => r.name === ROLE_TEXT_BAN);
  let roleVoice       = guild.roles.cache.find((r) => r.name === ROLE_VOICE_BAN);
  const needsText     = activeTypes.some((t) => ["text_ban",  "full_ban"].includes(t));
  const needsVoice    = activeTypes.some((t) => ["voice_ban", "full_ban"].includes(t));
  try {
    if (needsText) {
      if (!roleText) roleText = await getOrCreateRole(guild, ROLE_TEXT_BAN, { color: 0xff0000 });
      if (!member.roles.cache.has(roleText.id)) await member.roles.add(roleText, "GamesBook Punisher: text ban");
    } else {
      if (roleText && member.roles.cache.has(roleText.id)) await member.roles.remove(roleText, "GamesBook Punisher: text ban lifted");
    }
    if (needsVoice) {
      if (!roleVoice) roleVoice = await getOrCreateRole(guild, ROLE_VOICE_BAN, { color: 0xffa500 });
      if (!member.roles.cache.has(roleVoice.id)) await member.roles.add(roleVoice, "GamesBook Punisher: voice ban");
    } else {
      if (roleVoice && member.roles.cache.has(roleVoice.id)) await member.roles.remove(roleVoice, "GamesBook Punisher: voice ban lifted");
    }
    if (activeTypes.length > 0) {
      await bannedChannel.permissionOverwrites.create(member, { ViewChannel: true, SendMessages: true });
    } else {
      await bannedChannel.permissionOverwrites.delete(member);
    }
  } catch {}
}

// ==========================================
// --- 5. refresh_logs ---
// ==========================================
async function refreshLogs(guild) {
  const channel = await getOrCreateChannel(guild, "punisher_logs", false);
  const rows    = db.prepare("SELECT user_id, type, end_time, reason, admin_id FROM punishments WHERE guild_id=?").all(guild.id);
  const saved   = db.prepare("SELECT message_id, channel_id FROM log_messages WHERE guild_id=?").get(guild.id);

  const embed = new EmbedBuilder()
    .setTitle("🛰️ سجل الرقابة والحظر النشط")
    .setColor(0x2b2d31)
    .setTimestamp()
    .setFooter({ text: "Made by iam.alpha from UltraCodeSpace Group" });

  if (!rows.length) {
    embed.setDescription("✅ السيرفر نظيف حالياً، لا توجد عقوبات نشطة.");
  } else {
    for (const r of rows) {
      const mem   = guild.members.cache.get(String(r.user_id));
      const admin = guild.members.cache.get(String(r.admin_id));
      const endTs = Math.floor(getAwareDt(r.end_time).getTime() / 1000);
      embed.addFields({
        name:   `👤 ${mem ? mem.displayName : r.user_id}`,
        value:  `**النوع:** \`${r.type}\`\n**السبب:** ${r.reason}\n**بواسطة:** ${admin ? `<@${admin.id}>` : "غير معروف"}\n**ينتهي:** <t:${endTs}:R>`,
        inline: false,
      });
    }
  }

  let existingMsg = null;
  if (saved) {
    try {
      const savedCh = guild.channels.cache.get(String(saved.channel_id)) || channel;
      existingMsg   = await savedCh.messages.fetch(String(saved.message_id));
    } catch { existingMsg = null; }
  }

  if (existingMsg) {
    await existingMsg.edit({ embeds: [embed] });
  } else {
    const newMsg = await channel.send({ embeds: [embed] });
    db.prepare("INSERT OR REPLACE INTO log_messages (guild_id, message_id, channel_id) VALUES (?,?,?)")
      .run(guild.id, newMsg.id, channel.id);
  }
  lastEventTime = Date.now();
}

// ==========================================
// --- 6. منطق العقوبات ---
// ==========================================
async function processPunishLogic(interaction, member, pType, addedDurMs, reason) {
  if (isSystemOwner(member))
    return interaction.followUp({ content: "❌ لا يمكن معاقبة الأونر!", flags: 64 });

  const now      = new Date();
  const existing = db.prepare("SELECT end_time FROM punishments WHERE user_id=? AND guild_id=? AND type=?")
    .get(member.id, interaction.guild.id, pType);

  let msg;
  if (existing) {
    const currentEnd = getAwareDt(existing.end_time);
    const baseTime   = currentEnd > now ? currentEnd : now;
    const finalEnd   = new Date(baseTime.getTime() + addedDurMs);
    db.prepare("UPDATE punishments SET end_time=?, admin_id=?, reason=? WHERE user_id=? AND guild_id=? AND type=?")
      .run(finalEnd.toISOString(), interaction.user.id, reason, member.id, interaction.guild.id, pType);
    msg = `⏳ تم زيادة مدة \`${pType}\` لـ ${member.displayName}. تنتهي: <t:${Math.floor(finalEnd.getTime() / 1000)}:R>`;
  } else {
    const finalEnd = new Date(now.getTime() + addedDurMs);
    db.prepare("INSERT INTO punishments (user_id, guild_id, type, end_time, admin_id, reason) VALUES (?,?,?,?,?,?)")
      .run(member.id, interaction.guild.id, pType, finalEnd.toISOString(), interaction.user.id, reason);
    msg = `✅ تم تطبيق \`${pType}\` على ${member.displayName}`;
  }

  invalidateCache(interaction.guild.id);
  await applyLockdown(member, interaction.guild);
  await refreshLogs(interaction.guild);
  await interaction.followUp({ content: msg, flags: 64 });
}

async function processWarnLogic(interaction, member, reason) {
  if (isSystemOwner(member))
    return interaction.followUp({ content: "❌ لا يمكن تحذير الأونر!", flags: 64 });

  const res   = db.prepare("SELECT warn_count FROM warnings WHERE user_id=? AND guild_id=?").get(member.id, interaction.guild.id);
  const count = res ? res.warn_count + 1 : 1;

  if (count >= 3) {
    db.prepare("DELETE FROM warnings WHERE user_id=? AND guild_id=?").run(member.id, interaction.guild.id);
    await processPunishLogic(interaction, member, "text_ban", 60 * 60 * 1000, "تجاوز حد التحذيرات (3/3)");
  } else {
    if (res) db.prepare("UPDATE warnings SET warn_count=? WHERE user_id=? AND guild_id=?").run(count, member.id, interaction.guild.id);
    else     db.prepare("INSERT INTO warnings VALUES (?,?,?)").run(member.id, interaction.guild.id, count);

    const embed = new EmbedBuilder()
      .setTitle("⚠️ تحذير رسمي")
      .setColor(0xffa500)
      .setTimestamp()
      .setFooter({ text: "Made by iam.alpha from UltraCodeSpace Group" })
      .addFields(
        { name: "العضو",  value: `<@${member.id}>` },
        { name: "السبب",  value: reason },
        { name: "العدد",  value: `${count}/3` },
        { name: "بواسطة", value: `<@${interaction.user.id}>` }
      );
    const logCh = await getOrCreateChannel(interaction.guild, "punisher_logs", false);
    await logCh.send({ embeds: [embed] });
    await interaction.followUp({ content: `⚠️ تم تحذير <@${member.id}> (${count}/3)`, flags: 64 });
  }
}

async function sendStatusEmbed(interaction, target, isDeferred = false) {
  const warns          = db.prepare("SELECT warn_count FROM warnings WHERE user_id=? AND guild_id=?").get(target.id, interaction.guild.id);
  const puns           = db.prepare("SELECT type, end_time, reason FROM punishments WHERE user_id=? AND guild_id=?").all(target.id, interaction.guild.id);
  const history        = db.prepare("SELECT type, start_time, reason FROM punishment_history WHERE user_id=? AND guild_id=? ORDER BY start_time DESC LIMIT 5").all(target.id, interaction.guild.id);
  const pardonRequests = db.prepare("SELECT id, punishment_type, status, created_at FROM pardon_requests WHERE user_id=? AND guild_id=? ORDER BY created_at DESC LIMIT 3").all(target.id, interaction.guild.id);

  const embed = new EmbedBuilder()
    .setTitle(`📋 ملف العضو: ${target.displayName}`)
    .setColor(0x2b2d31)
    .setThumbnail(target.displayAvatarURL())
    .setFooter({ text: "Made by iam.alpha from UltraCodeSpace Group" })
    .addFields(
      { name: "الرتبة",    value: getUserRank(target),                    inline: true },
      { name: "التحذيرات", value: `${warns ? warns.warn_count : 0}/3`,    inline: true }
    );

  if (puns.length) {
    embed.addFields({ name: "العقوبات النشطة", inline: false,
      value: puns.map((p) => `• \`${p.type}\` | السبب: ${p.reason}\n  ينتهي: <t:${Math.floor(getAwareDt(p.end_time).getTime() / 1000)}:R>`).join("\n") });
  } else {
    embed.addFields({ name: "الحالة", value: "🟢 سجل نظيف", inline: false });
  }

  if (history.length)
    embed.addFields({ name: "📜 آخر 5 عقوبات سابقة", value: history.map((h) => `• \`${h.type}\` — ${h.reason}`).join("\n"), inline: false });

  const statusMap = { pending: "🕐 قيد المراجعة", accepted_full: "✅ قبول كامل", accepted_reduce: "⏳ تخفيف", rejected: "❌ مرفوض" };
  if (pardonRequests.length)
    embed.addFields({ name: "📩 طلبات العفو الأخيرة", value: pardonRequests.map((pr) => `• \`${pr.punishment_type}\` — ${statusMap[pr.status] || pr.status}`).join("\n"), inline: false });

  const isSelf   = target.id === interaction.user.id;
  let components = [];

  if (puns.length && isSelf) {
    const hasPending = db.prepare("SELECT 1 FROM pardon_requests WHERE user_id=? AND guild_id=? AND status='pending'").get(target.id, interaction.guild.id);
    if (hasPending) {
      embed.addFields({ name: "📩 طلب عفو", value: "⏳ لديك طلب عفو قيد المراجعة بالفعل.", inline: false });
    } else {
      embed.addFields({ name: "📩 طلب عفو", value: "يمكنك تقديم طلب عفو أو تخفيف عقوبة باستخدام القائمة أدناه.", inline: false });
      const select = new StringSelectMenuBuilder()
        .setCustomId("pardon_select")
        .setPlaceholder("اختر العقوبة التي تريد تقديم طلب عفو عنها...")
        .addOptions(puns.map((p) => ({ label: `طلب عفو عن: ${p.type}`, value: p.type, emoji: "📩" })));
      components = [new ActionRowBuilder().addComponents(select)];
    }
  }

  const payload = { embeds: [embed], components, flags: 64 };
  if (isDeferred || interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

async function processPardonRequest(interaction, pType, reason) {
  const { user, guild } = interaction;
  const now             = new Date().toISOString();
  const punishment      = db.prepare("SELECT end_time, reason FROM punishments WHERE user_id=? AND guild_id=? AND type=?").get(user.id, guild.id, pType);

  if (!punishment) return interaction.followUp({ content: "❌ لا توجد عقوبة نشطة من هذا النوع!", flags: 64 });

  const hasPending = db.prepare("SELECT 1 FROM pardon_requests WHERE user_id=? AND guild_id=? AND status='pending'").get(user.id, guild.id);
  if (hasPending)  return interaction.followUp({ content: "⏳ لديك طلب عفو قيد المراجعة بالفعل. يرجى الانتظار.", flags: 64 });

  db.prepare("INSERT INTO pardon_requests (user_id, guild_id, punishment_type, reason, status, created_at) VALUES (?,?,?,?,?,?)")
    .run(user.id, guild.id, pType, reason, "pending", now);

  const req       = db.prepare("SELECT id FROM pardon_requests WHERE user_id=? AND guild_id=? AND created_at=?").get(user.id, guild.id, now);
  const requestId = req ? req.id : 0;
  const logCh     = await getOrCreateChannel(guild, "punisher_logs", false);
  const endTs     = Math.floor(getAwareDt(punishment.end_time).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle("📩 طلب عفو / تخفيف عقوبة")
    .setColor(0x3498db)
    .setTimestamp()
    .setThumbnail(user.displayAvatarURL())
    .setFooter({ text: "Made by iam.alpha from UltraCodeSpace Group" })
    .addFields(
      { name: "العضو",        value: `<@${user.id}> (\`${user.id}\`)`, inline: false },
      { name: "نوع العقوبة",  value: `\`${pType}\``,                   inline: true  },
      { name: "سبب العقوبة",  value: punishment.reason || "غير محدد",  inline: true  },
      { name: "تنتهي في",     value: `<t:${endTs}:R>`,                  inline: true  },
      { name: "سبب طلب العفو",value: reason,                            inline: false }
    )
    .setFooter({ text: `طلب #${String(requestId).padStart(4, "0")} •Developed by iam.alpha` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pardon_accept_full_${requestId}_${user.id}_${pType}`)   .setLabel("✅ قبول (عفو كامل)")  .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`pardon_accept_reduce_${requestId}_${user.id}_${pType}`).setLabel("⏳ قبول (تخفيف المدة)").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`pardon_reject_${requestId}_${user.id}_${pType}`)       .setLabel("❌ رفض")               .setStyle(ButtonStyle.Danger)
  );

  await logCh.send({ content: "📋 **طلب عفو جديد — يتطلب مراجعة الإداريين**", embeds: [embed], components: [row] });
  await interaction.followUp({ content: "✅ تم إرسال طلب العفو الخاص بك للإداريين. سيتم إشعارك بالنتيجة.", flags: 64 });
}

async function resolvePardon(interaction, requestId, userId, guildId, pType, decision) {
  const { guild }  = interaction;
  const member     = guild.members.cache.get(String(userId));
  const nowIso     = new Date().toISOString();

  db.prepare("UPDATE pardon_requests SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?")
    .run(decision, interaction.user.id, nowIso, requestId);

  const decisionMap = {
    accepted_full:   { text: "✅ تم قبول طلب العفو — تم إزالة العقوبة كاملاً.", color: 0x2ecc71 },
    accepted_reduce: { text: "⏳ تم قبول طلب التخفيف — تم تقليل مدة العقوبة.", color: 0x3498db },
    rejected:        { text: "❌ تم رفض طلب العفو.",                             color: 0xe74c3c },
  };
  const { text: msgText, color } = decisionMap[decision] || { text: "تم اتخاذ قرار.", color: 0x95a5a6 };

  if (decision === "accepted_full") {
    db.prepare("DELETE FROM punishments WHERE user_id=? AND guild_id=? AND type=?").run(userId, guildId, pType);
    invalidateCache(guildId);
    if (member) await applyLockdown(member, guild);
    await refreshLogs(guild);
  } else if (decision === "accepted_reduce") {
    const row = db.prepare("SELECT end_time FROM punishments WHERE user_id=? AND guild_id=? AND type=?").get(userId, guildId, pType);
    if (row) {
      const endDt     = getAwareDt(row.end_time);
      const nowDt     = new Date();
      const remaining = endDt.getTime() - nowDt.getTime();
      const newEnd    = new Date(nowDt.getTime() + remaining / 2);
      db.prepare("UPDATE punishments SET end_time=? WHERE user_id=? AND guild_id=? AND type=?").run(newEnd.toISOString(), userId, guildId, pType);
      invalidateCache(guildId);
      await refreshLogs(guild);
    }
  }

  if (member) {
    try {
      const notifyEmbed = new EmbedBuilder()
        .setTitle("📋 نتيجة طلب العفو")
        .setDescription(msgText)
        .setColor(color)
        .setTimestamp()
        .setFooter({ text: "Made by iam.alpha from UltraCodeSpace Group" })
        .addFields(
          { name: "السيرفر",     value: guild.name,                    inline: true },
          { name: "نوع العقوبة", value: `\`${pType}\``,                inline: true },
          { name: "بواسطة",      value: interaction.user.displayName,  inline: true }
        );
      await member.send({ embeds: [notifyEmbed] });
    } catch {}
  }

  const resultEmbed = new EmbedBuilder()
    .setTitle(`📩 طلب عفو #${String(requestId).padStart(4, "0")} — ${msgText.slice(0, 30)}`)
    .setDescription(msgText)
    .setColor(color)
    .setTimestamp()
    .setFooter({ text: "Made by iam.alpha from UltraCodeSpace Group" })
    .addFields(
      { name: "العضو",  value: `<@${userId}>`,               inline: true  },
      { name: "القرار", value: msgText,                       inline: false },
      { name: "بواسطة", value: `<@${interaction.user.id}>`,  inline: true  }
    );
  await interaction.update({ embeds: [resultEmbed], components: [] });
}

// ==========================================
// --- 7. Builder Helpers ---
// ==========================================
function buildUserSelectRow(customId) {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder().setCustomId(customId).setPlaceholder("اختر العضو المستهدف...")
  );
}

function buildBanTypeSelect(targetId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`bantype_${targetId}`).setPlaceholder("اختر نوع العقوبة...")
      .addOptions([
        { label: "سجن كتابي (Text Ban)",  value: "text_ban",  emoji: "🚫" },
        { label: "سجن صوتي (Voice Ban)",  value: "voice_ban", emoji: "🎙️" },
        { label: "سجن كامل (Full Ban)",   value: "full_ban",  emoji: "🔒" },
      ])
  );
}

function buildClearManagementRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("clear_remove_spec") .setLabel("إزالة عقوبة محددة لعضو")          .setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("clear_all_spec")    .setLabel("إزالة جميع عقوبات عضو")            .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("clear_warns_spec")  .setLabel("تصفير تحذيرات عضو")                .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("clear_type_all")    .setLabel("إزالة نوع عقوبة عن الجميع (أونر)") .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("clear_all_server")  .setLabel("تصفير السيرفر بالكامل (أونر)")     .setStyle(ButtonStyle.Danger)
  );
}

function buildOwnerClearTypeSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId("owner_clear_type_select").setPlaceholder("اختر نوع العقوبة لفكها عن الجميع...")
      .addOptions([
        { label: "مسح كل السجن الكتابي", value: "text_ban",  emoji: "🚫" },
        { label: "مسح كل السجن الصوتي", value: "voice_ban", emoji: "🎙️" },
        { label: "مسح كل السجن الكامل", value: "full_ban",  emoji: "🔒" },
      ])
  );
}

function buildPunishModal(pType, targetId) {
  const modal = new ModalBuilder().setCustomId(`punish_modal_${pType}_${targetId}`).setTitle("تفاصيل العقوبة");
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("السبب").setStyle(TextInputStyle.Paragraph).setPlaceholder("أدخل سبب العقوبة...").setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("days")  .setLabel("الأيام")  .setStyle(TextInputStyle.Short).setPlaceholder("0").setValue("0").setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("hours") .setLabel("الساعات").setStyle(TextInputStyle.Short).setPlaceholder("0").setValue("0").setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("mins")  .setLabel("الدقائق").setStyle(TextInputStyle.Short).setPlaceholder("0").setValue("0").setRequired(false))
  );
  return modal;
}

function buildWarnModal(targetId) {
  const modal = new ModalBuilder().setCustomId(`warn_modal_${targetId}`).setTitle("سبب التحذير");
  modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("السبب").setStyle(TextInputStyle.Paragraph).setRequired(true)));
  return modal;
}

function buildPardonModal(pType) {
  const modal = new ModalBuilder().setCustomId(`pardon_modal_${pType}`).setTitle("طلب عفو / تخفيف عقوبة");
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId("pardon_reason").setLabel("سبب طلب العفو")
      .setStyle(TextInputStyle.Paragraph).setPlaceholder("اشرح سبب طلبك للعفو أو تخفيف العقوبة...").setRequired(true).setMaxLength(500)
  ));
  return modal;
}

// ==========================================
// --- 8. Setup — نقطة الدخول للـ Cog ---
// ==========================================
export async function setup(client) {

  updateOwnersCache(client);

  const commands = [
    new SlashCommandBuilder().setName("punisher").setDescription("فتح لوحة التحكم لـ GamesBook Punisher").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName("punisher_status").setDescription("عرض حالتك أو حالة عضو").addUserOption((o) => o.setName("member").setDescription("العضو المستهدف").setRequired(false)),
    new SlashCommandBuilder().setName("make_owner").setDescription("إضافة أونر جديد للنظام").setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addUserOption((o) => o.setName("member").setDescription("العضو المراد ترقيته").setRequired(true)),
  ];

  for (const cmd of commands) {
    client.slashCommands.set(cmd.name, {
      data: cmd,
      execute: async (interaction) => handleSlash(interaction, client),
    });
  }

  // check_punishments كل 15 ثانية
  setInterval(async () => {
    const nowLoop      = new Date();
    const rows         = db.prepare("SELECT user_id, guild_id, type, end_time FROM punishments").all();
    const needsRefresh = new Set();
    for (const row of rows) {
      if (nowLoop >= getAwareDt(row.end_time)) {
        db.prepare("DELETE FROM punishments WHERE user_id=? AND guild_id=? AND type=?").run(row.user_id, row.guild_id, row.type);
        invalidateCache(row.guild_id);
        const g = client.guilds.cache.get(String(row.guild_id));
        if (g) {
          const m = g.members.cache.get(String(row.user_id));
          if (m) await applyLockdown(m, g);
          needsRefresh.add(row.guild_id);
        }
      }
    }
    for (const gid of needsRefresh) {
      const g = client.guilds.cache.get(String(gid));
      if (g) await refreshLogs(g);
    }
  }, 15 * 1000);

  // auto_refresh_logs كل 5 دقائق
  setInterval(async () => {
    if (Date.now() - lastEventTime >= 5 * 60 * 1000) {
      for (const guild of client.guilds.cache.values()) await refreshLogs(guild);
    }
  }, 5 * 60 * 1000);

  // update_banned_topic كل دقيقتين
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const ch = guild.channels.cache.find((c) => c.name === "banned" && c.type === ChannelType.GuildText);
      if (ch) {
        const row   = db.prepare("SELECT COUNT(DISTINCT user_id) as cnt FROM punishments WHERE guild_id=?").get(guild.id);
        const count = row ? row.cnt : 0;
        try { await ch.setTopic(`المعاقبين حالياً: ${count} | GamesBook Punisher | Developed by iam.alpha, Founder of UltraCodeSpace Group`); } catch {}
      }
    }
  }, 2 * 60 * 1000);

  client.on("componentInteraction", async (interaction) => {
    try {
      if (interaction.isButton())        await handleButton(interaction, client);
      if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) await handleSelect(interaction, client);
      if (interaction.isModalSubmit())   await handleModal(interaction, client);
    } catch (err) {
      console.error(`[Punisher] ❌ Component error: ${err.message}`);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) return;
    if (message.channel.name === "banned") {
      if (message.content.startsWith("/") || message.content.startsWith("!")) return;
      const found = db.prepare("SELECT 1 FROM punishments WHERE user_id=? AND guild_id=?").get(message.author.id, message.guild.id);
      if (found) { try { await message.delete(); } catch {} }
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    const found = db.prepare("SELECT 1 FROM punishments WHERE user_id=? AND guild_id=?").get(member.id, member.guild.id);
    if (found) await applyLockdown(member, member.guild);
  });

  client.on(Events.GuildMemberUpdate, async (before, after) => {
    const punRoleNames    = new Set([ROLE_TEXT_BAN, ROLE_VOICE_BAN, ROLE_FULL_BAN]);
    const removedRoles    = before.roles.cache.filter((r) => !after.roles.cache.has(r.id));
    const removedPunRoles = removedRoles.filter((r) => punRoleNames.has(r.name));
    if (!removedPunRoles.size) return;

    const activePunishments = db.prepare("SELECT type FROM punishments WHERE user_id=? AND guild_id=?")
      .all(after.id, after.guild.id).map((r) => r.type);
    if (!activePunishments.length) return;

    let needsRestore = false;
    for (const role of removedPunRoles.values()) {
      if (role.name === ROLE_TEXT_BAN  && activePunishments.some((t) => ["text_ban",  "full_ban"].includes(t))) needsRestore = true;
      if (role.name === ROLE_VOICE_BAN && activePunishments.some((t) => ["voice_ban", "full_ban"].includes(t))) needsRestore = true;
      if (role.name === ROLE_FULL_BAN  && activePunishments.includes("full_ban"))                               needsRestore = true;
    }

    if (needsRestore) {
      try {
        await applyLockdown(after, after.guild);
        const logCh = await getOrCreateChannel(after.guild, "punisher_logs");
        await logCh.send({
          embeds: [new EmbedBuilder()
            .setTitle("⚠️ محاولة إزالة عقوبة يدوياً")
            .setDescription(`تم إعادة تطبيق العقوبة على <@${after.id}> تلقائياً.`)
            .setColor(0xf1c40f)
            .setTimestamp()
            .setFooter({ text: "Made by iam.alpha from UltraCodeSpace Group" })
            .addFields({ name: "الـ Roles المُعادة", value: [...removedPunRoles.values()].map((r) => `\`${r.name}\``).join("\n") })
          ],
        });
      } catch {}
    }
  });

  const now            = new Date();
  const allPunishments = db.prepare("SELECT user_id, guild_id, type, end_time FROM punishments").all();
  const expired        = allPunishments.filter((p) => now >= getAwareDt(p.end_time));
  const active         = allPunishments.filter((p) => now <  getAwareDt(p.end_time));

  if (expired.length) {
    const delStmt = db.prepare("DELETE FROM punishments WHERE user_id=? AND guild_id=? AND type=?");
    db.transaction((items) => { for (const p of items) delStmt.run(p.user_id, p.guild_id, p.type); })(expired);
  }

  for (const guild of client.guilds.cache.values()) {
    let needRefresh = false;
    for (const member of guild.members.cache.values()) {
      if (member.user.bot) continue;
      const punRoleNames = new Set([ROLE_TEXT_BAN, ROLE_VOICE_BAN, ROLE_FULL_BAN]);
      const hasPunRole   = member.roles.cache.some((r) => punRoleNames.has(r.name));
      const hasActive    = active.some((p) => String(p.user_id) === member.id && String(p.guild_id) === guild.id);
      const hasExpired   = expired.some((p) => String(p.user_id) === member.id && String(p.guild_id) === guild.id);
      if (hasActive || hasExpired || hasPunRole) {
        await applyLockdown(member, guild);
        needRefresh = true;
      }
    }
    if (needRefresh) { try { await refreshLogs(guild); } catch {} }
  }

  console.log(`  🛡️  Punisher cog loaded —Developed by iam.alpha, Founder of UltraCodeSpace Group — ${active.length} نشطة، ${expired.length} منتهية حُذفت`);
}

// ==========================================
// --- 9. Slash Handler ---
// ==========================================
async function handleSlash(interaction, client) {
  const cmd = interaction.commandName;

  if (cmd === "punisher") {
    const embed = new EmbedBuilder()
      .setTitle("🛰️ GamesBook Control Hub")
      .setDescription("نظام الحماية والرقابة المركزية")
      .setColor(0x2b2d31)
      .setFooter({ text: "Made by iam.alpha from UltraCodeSpace Group" });
    const row   = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("dash_punish").setLabel("عقاب جديد")           .setStyle(ButtonStyle.Danger)   .setEmoji("🚫"),
      new ButtonBuilder().setCustomId("dash_warn")  .setLabel("تحذير عضو")           .setStyle(ButtonStyle.Secondary).setEmoji("⚠️"),
      new ButtonBuilder().setCustomId("dash_clear") .setLabel("إدارة القيود الشاملة").setStyle(ButtonStyle.Success)  .setEmoji("🛠️"),
      new ButtonBuilder().setCustomId("dash_status").setLabel("حالة عضو")            .setStyle(ButtonStyle.Primary)  .setEmoji("🔍")
    );
    return interaction.reply({ embeds: [embed], components: [row], flags: 64 });
  }

  if (cmd === "punisher_status") {
    const target = interaction.options.getMember("member") || interaction.member;
    if (target.id !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !isSystemOwner(interaction.member))
      return interaction.reply({ content: "❌ يمكنك رؤية ملفك فقط!", flags: 64 });
    return sendStatusEmbed(interaction, target);
  }

  if (cmd === "make_owner") {
    if (!isSystemOwner(interaction.member)) return interaction.reply({ content: "❌ للأونر الأساسي فقط!", flags: 64 });
    const member = interaction.options.getMember("member");
    db.prepare("INSERT OR IGNORE INTO bot_owners (user_id) VALUES (?)").run(member.id);
    updateOwnersCache(client);
    return interaction.reply({ content: `👑 تم ترقية <@${member.id}> أونر بنجاح!`, flags: 64 });
  }
}

// ==========================================
// --- 10. Button Handler ---
// ==========================================
async function handleButton(interaction, client) {
  const id = interaction.customId;

  const punisherBtns = [
    "dash_punish","dash_warn","dash_clear","dash_status",
    "clear_remove_spec","clear_all_spec","clear_warns_spec","clear_type_all","clear_all_server",
  ];
  const isPardon = id.startsWith("pardon_accept_full_") || id.startsWith("pardon_accept_reduce_") || id.startsWith("pardon_reject_");
  if (!punisherBtns.includes(id) && !isPardon) return;

  if (id === "dash_punish") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content: "❌ للأدمن فقط!", flags: 64 });
    return interaction.reply({ content: "اختر العضو لمعاقبته:", components: [buildUserSelectRow("punish_user_select")], flags: 64 });
  }
  if (id === "dash_warn") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content: "❌ للأدمن فقط!", flags: 64 });
    return interaction.reply({ content: "اختر العضو لتحذيره:", components: [buildUserSelectRow("warn_user_select")], flags: 64 });
  }
  if (id === "dash_clear") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content: "❌ للأدمن فقط!", flags: 64 });
    return interaction.reply({ content: "اختر الإجراء:", components: [buildClearManagementRow()], flags: 64 });
  }
  if (id === "dash_status") {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content: "اختر العضو:", components: [buildUserSelectRow("status_user_select")], flags: 64 });
    return sendStatusEmbed(interaction, interaction.member);
  }
  if (id === "clear_remove_spec") return interaction.update({ content: "اختر العضو:", components: [buildUserSelectRow("remove_spec_user_select")] });
  if (id === "clear_all_spec")    return interaction.update({ content: "اختر العضو لفك كل عقوباته:", components: [buildUserSelectRow("clear_all_punish_user_select")] });
  if (id === "clear_warns_spec")  return interaction.update({ content: "اختر العضو لتصفير تحذيراته:", components: [buildUserSelectRow("clear_warns_user_select")] });
  if (id === "clear_type_all") {
    if (!isSystemOwner(interaction.member)) return interaction.reply({ content: "❌ للأونر فقط!", flags: 64 });
    return interaction.update({ content: "اختر العقوبة المراد مسحها:", components: [buildOwnerClearTypeSelect()] });
  }
  if (id === "clear_all_server") {
    if (!isSystemOwner(interaction.member)) return interaction.reply({ content: "❌ للأونر فقط!", flags: 64 });
    const users = db.prepare("SELECT DISTINCT user_id FROM punishments WHERE guild_id=?").all(interaction.guild.id).map((r) => r.user_id);
    db.prepare("DELETE FROM punishments WHERE guild_id=?").run(interaction.guild.id);
    db.prepare("DELETE FROM warnings    WHERE guild_id=?").run(interaction.guild.id);
    invalidateCache(interaction.guild.id);
    for (const uid of users) { const m = interaction.guild.members.cache.get(String(uid)); if (m) await applyLockdown(m, interaction.guild); }
    await refreshLogs(interaction.guild);
    return interaction.update({ content: "✅ تم تصفير كافة السجلات والعقوبات.", components: [] });
  }

  if (isPardon) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content: "❌ للإداريين فقط!", flags: 64 });
    let decision, rest2;
    if      (id.startsWith("pardon_accept_full_"))   { decision = "accepted_full";   rest2 = id.replace("pardon_accept_full_",   ""); }
    else if (id.startsWith("pardon_accept_reduce_")) { decision = "accepted_reduce";  rest2 = id.replace("pardon_accept_reduce_", ""); }
    else                                             { decision = "rejected";          rest2 = id.replace("pardon_reject_",        ""); }
    const parts     = rest2.split("_");
    const requestId = parseInt(parts[0]);
    const userId    = parts[1];
    const pType     = parts.slice(2).join("_");
    return resolvePardon(interaction, requestId, userId, interaction.guild.id, pType, decision);
  }
}

// ==========================================
// --- 11. Select & Modal Handlers ---
// ==========================================
async function handleSelect(interaction, client) {
  const id  = interaction.customId;
  const val = interaction.values?.[0];

  if (interaction.isStringSelectMenu()) {
    if (id.startsWith("bantype_")) {
      const targetId = id.replace("bantype_", "");
      const target   = await interaction.guild.members.fetch(targetId).catch(() => null);
      if (!target) return interaction.update({ content: "❌ العضو غير موجود!", components: [] });
      return interaction.showModal(buildPunishModal(val, targetId));
    }
    if (id.startsWith("remove_spec_ban_")) {
      const targetId = id.replace("remove_spec_ban_", "");
      const existing = db.prepare("SELECT end_time, admin_id, reason FROM punishments WHERE user_id=? AND guild_id=? AND type=?").get(targetId, interaction.guild.id, val);
      if (existing) db.prepare("INSERT INTO punishment_history VALUES (?,?,?,?,?,?,?,?)").run(targetId, interaction.guild.id, val, new Date().toISOString(), existing.end_time, existing.admin_id, existing.reason, interaction.user.id);
      db.prepare("DELETE FROM punishments WHERE user_id=? AND guild_id=? AND type=?").run(targetId, interaction.guild.id, val);
      invalidateCache(interaction.guild.id);
      const target = await interaction.guild.members.fetch(targetId).catch(() => null);
      if (target) await applyLockdown(target, interaction.guild);
      await refreshLogs(interaction.guild);
      return interaction.update({ content: `✅ تم إزالة \`${val}\` عن <@${targetId}>`, components: [] });
    }
    if (id === "owner_clear_type_select") {
      if (!isSystemOwner(interaction.member)) return interaction.reply({ content: "❌ للأونر فقط!", flags: 64 });
      const users = db.prepare("SELECT DISTINCT user_id FROM punishments WHERE guild_id=? AND type=?").all(interaction.guild.id, val).map((r) => r.user_id);
      db.prepare("DELETE FROM punishments WHERE guild_id=? AND type=?").run(interaction.guild.id, val);
      invalidateCache(interaction.guild.id);
      for (const uid of users) { const m = interaction.guild.members.cache.get(String(uid)); if (m) await applyLockdown(m, interaction.guild); }
      await refreshLogs(interaction.guild);
      return interaction.update({ content: `✅ تم فك \`${val}\` عن جميع الأعضاء بواسطة الأونر.`, components: [] });
    }
    if (id === "pardon_select") return interaction.showModal(buildPardonModal(val));
  }

  if (interaction.isUserSelectMenu()) {
    const target = interaction.values[0] ? await interaction.guild.members.fetch(interaction.values[0]).catch(() => null) : null;
    if (!target) return interaction.update({ content: "❌ العضو غير موجود!", components: [] });

    if (id === "punish_user_select")      return interaction.update({ content: `✅ العضو: <@${target.id}>\nاختر النوع:`, components: [buildBanTypeSelect(target.id)] });
    if (id === "warn_user_select")        return interaction.showModal(buildWarnModal(target.id));
    if (id === "status_user_select")      { await interaction.deferUpdate(); return sendStatusEmbed(interaction, target, true); }
    if (id === "remove_spec_user_select") {
      const bans = db.prepare("SELECT type FROM punishments WHERE user_id=? AND guild_id=?").all(target.id, interaction.guild.id).map((r) => r.type);
      if (!bans.length) return interaction.update({ content: `❌ لا توجد عقوبات نشطة لـ <@${target.id}>`, components: [] });
      const select = new StringSelectMenuBuilder().setCustomId(`remove_spec_ban_${target.id}`).setPlaceholder("اختر العقوبة لإزالتها...").addOptions(bans.map((b) => ({ label: `إزالة ${b}`, value: b })));
      return interaction.update({ content: `اختر العقوبة المراد إزالتها لـ <@${target.id}>:`, components: [new ActionRowBuilder().addComponents(select)] });
    }
    if (id === "clear_all_punish_user_select") {
      db.prepare("DELETE FROM punishments WHERE user_id=? AND guild_id=?").run(target.id, interaction.guild.id);
      invalidateCache(interaction.guild.id);
      await applyLockdown(target, interaction.guild);
      await refreshLogs(interaction.guild);
      return interaction.update({ content: `✅ تم إزالة كافة العقوبات عن <@${target.id}>`, components: [] });
    }
    if (id === "clear_warns_user_select") {
      db.prepare("DELETE FROM warnings WHERE user_id=? AND guild_id=?").run(target.id, interaction.guild.id);
      return interaction.update({ content: `✅ تم تصفير كافة تحذيرات <@${target.id}>`, components: [] });
    }
  }
}

async function handleModal(interaction, client) {
  const id = interaction.customId;

  if (id.startsWith("punish_modal_")) {
    await interaction.deferReply({ flags: 64 });
    const rest2    = id.replace("punish_modal_", "");
    const parts    = rest2.split("_");
    const pType    = parts.slice(0, -1).join("_");
    const targetId = parts[parts.length - 1];
    const target   = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target) return interaction.followUp({ content: "❌ العضو غير موجود!", flags: 64 });
    const reason = interaction.fields.getTextInputValue("reason");
    const days   = parseInt(interaction.fields.getTextInputValue("days")  || "0") || 0;
    const hours  = parseInt(interaction.fields.getTextInputValue("hours") || "0") || 0;
    const mins   = parseInt(interaction.fields.getTextInputValue("mins")  || "0") || 0;
    if (!days && !hours && !mins) return interaction.followUp({ content: "❌ يجب إدخال مدة زمنية واحدة على الأقل!", flags: 64 });
    return processPunishLogic(interaction, target, pType, (days * 86400 + hours * 3600 + mins * 60) * 1000, reason);
  }

  if (id.startsWith("warn_modal_")) {
    await interaction.deferReply({ flags: 64 });
    const targetId = id.replace("warn_modal_", "");
    const target   = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target) return interaction.followUp({ content: "❌ العضو غير موجود!", flags: 64 });
    return processWarnLogic(interaction, target, interaction.fields.getTextInputValue("reason"));
  }

  if (id.startsWith("pardon_modal_")) {
    await interaction.deferReply({ flags: 64 });
    const pType = id.replace("pardon_modal_", "");
    return processPardonRequest(interaction, pType, interaction.fields.getTextInputValue("pardon_reason"));
  }
}
