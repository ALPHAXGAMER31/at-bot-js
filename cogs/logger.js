// ══════════════════════════════════════════
//  cogs/logger.js
//  Developed by iam.alpha, Founder of UltraCodeSpace Group
// ══════════════════════════════════════════

import { 
    EmbedBuilder, 
    Events, 
    PermissionFlagsBits, 
    SlashCommandBuilder 
} from 'discord.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || '.';
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

// إعداد قاعدة البيانات (تلقائياً في مجلد المشروع الأساسي)
const DB_PATH = join(dataDir, 'logger.db');
const db = new Database(DB_PATH);

// إنشاء الجدول إذا لم يكن موجوداً
db.exec(`
    CREATE TABLE IF NOT EXISTS log_settings (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT
    )
`);

const loggerCog = {
    // إعداد الأمر البرمجي لضبط قناة السجلات
    data: new SlashCommandBuilder()
        .setName('set-logs')
        .setDescription('⚙️ ضبط قناة السجلات المتطورة لـ AT BOT')
        .addChannelOption(option => 
            option.setName('channel')
                .setDescription('القناة المراد إرسال السجلات إليها')
                .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        const channel = interaction.options.getChannel('channel');
        
        db.prepare('INSERT OR REPLACE INTO log_settings (guild_id, channel_id) VALUES (?, ?)')
          .run(interaction.guild.id, channel.id);

        const embed = new EmbedBuilder()
            .setTitle('✅ تم ضبط نظام السجلات')
            .setDescription(`سيتم الآن إرسال جميع تحديثات السيرفر إلى ${channel}`)
            .setColor(0x9B59B6) // لون بنفسجي (Cyberpunk style)
            .setFooter({ text: 'UltraCodeSpace Group Systems' });

        await interaction.reply({ embeds: [embed], ephemeral: true });
    },

    // ميزة تعقب حذف الرسائل (مثال على وظيفة الـ Cog)
    async onMessageDelete(message) {
        if (!message.guild || message.author?.bot) return;

        const settings = db.prepare('SELECT channel_id FROM log_settings WHERE guild_id = ?').get(message.guild.id);
        if (!settings) return;

        const logChannel = message.guild.channels.cache.get(settings.channel_id);
        if (!logChannel) return;

        const logEmbed = new EmbedBuilder()
            .setAuthor({ name: '🗑️ رسالة محذوفة', iconURL: message.author.displayAvatarURL() })
            .setColor(0xE74C3C) // أحمر للتحذير
            .addFields(
                { name: 'المؤلف', value: `${message.author} (${message.author.id})`, inline: true },
                { name: 'القناة', value: `${message.channel}`, inline: true },
                { name: 'المحتوى', value: message.content || '`لا يوجد نص (قد تكون صورة أو ملف)`' }
            )
            .setTimestamp()
            .setFooter({ text: `Developed by iam.alpha` });

        await logChannel.send({ embeds: [logEmbed] });
    }
};

// تصدير الـ Cog للتوافق مع محرك البوت الخاص بك
export async function setup(client) {
    if (!client.slashCommands) client.slashCommands = new Map();
    client.slashCommands.set(loggerCog.data.name, loggerCog);

    // ربط الأحداث (Events)
    client.on(Events.MessageDelete, (message) => loggerCog.onMessageDelete(message));
    
    console.log('✅ Logger Cog Loaded Successfully.');
}
