import {
    Client,
    GatewayIntentBits,
    Collection,
    Events,
    ActivityType,
    EmbedBuilder,
    REST,
    Routes,
} from 'discord.js';
import { readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname }                       from 'path';
import { fileURLToPath }                       from 'url';
import { execSync }                            from 'child_process';
import { TOKEN, OWNER_IDS, GUILD_ID, MEDIA_ENABLED }          from './config.js';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ════════════════════════════════════════════════
//  🚀 نظام الـ Bootstrap المدمج (Auto-Install)
// ════════════════════════════════════════════════
function runInternalBootstrap() {
    console.log('🔍 فحص المكتبات الأساسية (Bootstrap)...');
    try {
        if (!existsSync('./package.json')) {
            console.log('📦 إنشاء ملف package.json...');
            execSync('npm init -y', { stdio: 'ignore' });
        }
        if (!existsSync('./node_modules')) {
            console.log('🚀 جاري تثبيت المكتبات (قد يستغرق بعض الوقت)...');
            execSync('npm install', { stdio: 'inherit' });
            console.log('✅ تم التثبيت بنجاح.');
        } else {
            console.log('✨ جميع المكتبات متوفرة.');
        }
    } catch (err) {
        console.error('❌ خطأ أثناء فحص المكتبات:', err.message);
    }
}
// تشغيل الفحص فوراً
runInternalBootstrap();

// ════════════════════════════════════════════════
//  💜 Developed by iam.alpha
// ════════════════════════════════════════════════

const SIGNATURE = {
    author : 'iam.alpha',
    group  : 'UltraCodeSpace Group',
    credit : '💜Developed by iam.alpha, Founder of UltraCodeSpace Group',
};

// ════════════════════════════════════════════════
//  🔍 فحص الإعدادات
// ════════════════════════════════════════════════
console.log('═'.repeat(60));
console.log(`💜 ${SIGNATURE.credit}`);
console.log('═'.repeat(60));
console.log('🔍 فحص الإعدادات...');

if (TOKEN) {
    console.log(`✅ TOKEN        → يبدأ بـ: ${TOKEN.slice(0, 20)}...`);
} else {
    console.log('❌ DISCORD_TOKEN غير موجود في .env');
    process.exit(1);
}

if (OWNER_IDS.length) {
    console.log(`✅ OWNER_IDS    → ${OWNER_IDS.join(', ')}`);
} else {
    console.log('⚠️  OWNER_IDS غير موجود - لن يكون هناك أونرز');
}

if (GUILD_ID) {
    console.log(`✅ GUILD_ID     → ${GUILD_ID}`);
} else {
    console.log('⚠️  GUILD_ID غير موجود - المزامنة ستكون عالمية (بطيئة)');
}

console.log('═'.repeat(60));

// ════════════════════════════════════════════════
//  🤖 إنشاء الـ Client
// ════════════════════════════════════════════════
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers, // 👈 ضروري جداً لتتبع تغيير الرتب (GuildMemberUpdate)
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildVoiceStates,
    ]
});

client.commands      = new Collection();
client.slashCommands = new Collection();
client.ownerIds      = new Set(OWNER_IDS);

// ════════════════════════════════════════════════
//  📦 تحميل الـ Cogs
// ════════════════════════════════════════════════
async function loadCogs() {
    console.log('─'.repeat(60));
    console.log('⚙️  جاري تحميل الموديولات...');
    console.log('─'.repeat(60));

    // دعم المجلد الحالي أو مجلد cogs
    const cogsPath = existsSync(join(__dirname, 'cogs')) ? join(__dirname, 'cogs') : __dirname;

    if (!existsSync(cogsPath)) {
        console.log('⚠️  مجلد cogs غير موجود، جاري إنشاؤه...');
        mkdirSync(cogsPath, { recursive: true });
    }

    // 🛑 تجاهل الملفات الأساسية وملف bootstrap القديم
    const ignoreFiles = ['index.js', 'bootstrap.js', 'config.js'];
    const mediaDisabled = !MEDIA_ENABLED;

    const files = readdirSync(cogsPath)
        .filter(f => f.endsWith('.js') && !f.startsWith('_') && !ignoreFiles.includes(f))
        .sort();

    let loaded = 0;
    let failed = 0;

    for (const file of files) {
        try {
            if (mediaDisabled && file === 'media.js') {
                console.log(`  ⏭️  ${file.padEnd(25)} → skipped (MEDIA_ENABLED=false)`);
                continue;
            }

            const cogPath = join(cogsPath, file);
            const cog     = await import(`file://${cogPath}`);

            // الفحص الذكي لتجاهل الملفات التي لا تحتوي على دالة setup
            if (typeof cog.setup !== 'function') {
                continue;
            }

            await cog.setup(client);

            console.log(`  ✅ ${file.padEnd(25)} → تم التحميل`);
            loaded++;

        } catch (err) {
            console.log(`  ❌ ${file.padEnd(25)} → فشل: ${err.message}`);
            failed++;
        }
    }

    console.log('─'.repeat(60));
    console.log(`📦 النتيجة: ✅ ${loaded} نجح | ❌ ${failed} فشل`);
}

// ════════════════════════════════════════════════
//  🔄 مزامنة الأوامر (مع حل مشكلة التكرار)
// ════════════════════════════════════════════════
async function syncCommands(retries = 3) {
    console.log('─'.repeat(60));
    console.log('🔄 جاري مزامنة الأوامر...');

    const seen     = new Set();
    const commands = [];

    // إزالة التكرار البرمجي الداخلي
    for (const [name, cmd] of client.slashCommands) {
        if (seen.has(name)) continue;
        seen.add(name);
        const json = cmd.data?.toJSON?.() ?? cmd.data;
        if (json) commands.push(json);
    }

    if (commands.length === 0) {
        console.log('⚠️  مفيش أوامر للمزامنة');
        console.log('─'.repeat(60));
        return;
    }

    console.log(`📋 الأوامر: ${commands.map(c => c.name).join(', ')}`);

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        if (GUILD_ID) {
            // 🛑 تنظيف الأوامر العالمية لمنع التكرار (Global Cleanup)
            await rest.put(Routes.applicationCommands(client.user.id), { body: [] });

            // ⚡ رفع الأوامر للسيرفر المحدد فقط
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, GUILD_ID),
                { body: commands }
            );
            console.log(`⚡ تم تنظيف الأوامر المكررة ومزامنة ${commands.length} أمر للسيرفر: ${GUILD_ID}`);
        } else {
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commands }
            );
            console.log(`⚡ تم مزامنة ${commands.length} أمر عالمياً`);
        }

    } catch (err) {
        if (err.status === 429) {
            const wait = (err.retryAfter ?? 30) * 1000;
            console.log(`⚠️  Rate Limit! انتظر ${wait / 1000} ثانية...`);
            await new Promise(r => setTimeout(r, wait));
            if (retries > 0) await syncCommands(retries - 1);
        } else {
            console.log(`❌ فشلت المزامنة: ${err.message}`);
        }
    }

    console.log('─'.repeat(60));
}

// ════════════════════════════════════════════════
//  🎯 Events
// ════════════════════════════════════════════════
client.once(Events.ClientReady, async (c) => {
    console.log('═'.repeat(60));
    console.log(`💜 ${SIGNATURE.credit}`);
    console.log('═'.repeat(60));
    console.log('🚀 Bot System Online');
    console.log(`👤 البوت      : ${c.user.username} (${c.user.id})`);
    console.log(`📊 السيرفرات  : ${c.guilds.cache.size}`);
    console.log(`👥 المستخدمين : ${c.guilds.cache.reduce((a, g) => a + g.memberCount, 0)}`);
    console.log(`⏱️  Ping        : ${Math.round(c.ws.ping)}ms`);
    console.log('═'.repeat(60));

    await loadCogs();
    await syncCommands();
    startKeepAlive();

    c.user.setPresence({
        activities: [{
            name: 'Online ',
            type: ActivityType.Watching,
        }],
        status: 'online',
    });
});

// ── Slash Commands ──
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const command = client.slashCommands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.execute(interaction, client);
        } catch (err) {
            console.error(`⚠️  خطأ في '${interaction.commandName}': ${err}`);
            const payload = { content: '❌ حصل خطأ!', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(payload).catch(() => {});
            } else {
                await interaction.reply(payload).catch(() => {});
            }
        }
        return;
    }

    if (
        interaction.isButton()        ||
        interaction.isModalSubmit()   ||
        interaction.isAnySelectMenu()
    ) {
        client.emit('componentInteraction', interaction);
    }
});

// ── Prefix Commands ──
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot)               return;
    if (!message.content.startsWith('!')) return;

    const args        = message.content.slice(1).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    const command     = client.commands.get(commandName);
    if (!command) return;

    try {
        await command.execute(message, args, client);
    } catch (err) {
        console.error(`⚠️  خطأ في '${commandName}': ${err}`);
        await message.reply('❌ حصل خطأ!').catch(() => {});
    }
});

// ════════════════════════════════════════════════
//  🔍 أمر !check
// ════════════════════════════════════════════════
client.commands.set('check', {
    execute: async (message, args, client) => {
        const embed = new EmbedBuilder()
            .setTitle('✅ System Status')
            .setDescription('النظام يعمل بشكل مثالي!')
            .setColor(0x00FF00)
            .addFields(
                { name: '🤖 البوت',      value: `<@${client.user.id}>`,             inline: true },
                { name: '🌐 السيرفرات', value: String(client.guilds.cache.size),   inline: true },
                { name: '⏱️ Ping',       value: `${Math.round(client.ws.ping)}ms`, inline: true },
                {
                    name  : '💜 Credits',
                    value : `**${SIGNATURE.credit}**`,
                    inline: false,
                },
            );

        await message.reply({ embeds: [embed] });
    }
});

// ════════════════════════════════════════════════
//  🚀 تشغيل البوت
// ════════════════════════════════════════════════

// ── 🌐 HTTP Keep-Alive (يمنع سكون Render المجاني بعد 15 دقيقة) ──
// لا يستمع فوراً — كوج at_community يشغل OAuth Server على نفس المنفذ،
// فنستمع بعد تحميل الكوجز فقط، وإذا كان المنفذ مشغولاً نتجاهلها بهدوء.
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.get('/', (req, res) => res.send('OK'));

function startKeepAlive() {
    try {
        const server = app.listen(PORT, () => {
            console.log(`🌐 HTTP Keep-Alive يعمل على المنفذ ${PORT}`);
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.log('ℹ️  المنفذ مشغول (OAuth Server شغال) — Keep-Alive مغطى بالفعل');
            } else {
                console.log(`⚠️  HTTP Server: ${err.message}`);
            }
        });
    } catch (err) {
        console.log(`⚠️  تعذر تشغيل HTTP Server: ${err.message}`);
    }
}

try {
    await client.login(TOKEN);
} catch (err) {
    if (err.code === 'TokenInvalid') {
        console.log('═'.repeat(60));
        console.log('❌ فشل تسجيل الدخول! TOKEN خاطئ أو منتهي');
        console.log('💡 اذهب إلى: discord.com/developers/applications');
        console.log('   ثم اضغط Reset Token وحدّث .env');
        console.log('═'.repeat(60));
    } else if (err.message?.includes('disallowed intents')) {
        console.log('═'.repeat(60));
        console.log('❌ يجب تفعيل Privileged Intents!');
        console.log('💡 اذهب إلى: discord.com/developers/applications');
        console.log('   Bot → Privileged Gateway Intents → فعّل الثلاثة');
        console.log('═'.repeat(60));
    } else {
        console.log(`❌ خطأ غير متوقع: ${err.message}`);
    }
    process.exit(1);
}

// ── إيقاف نظيف ──
process.on('SIGINT', () => {
    console.log('\n👋 تم إيقاف البوت يدوياً');
    console.log(`💜 ${SIGNATURE.credit}`);
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 تم إيقاف البوت (SIGTERM - إعادة نشر على Render)');
    console.log(`💜 ${SIGNATURE.credit}`);
    client.destroy();
    process.exit(0);
});
