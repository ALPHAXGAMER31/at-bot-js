import {
    SlashCommandBuilder,
    EmbedBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';

import Database from 'better-sqlite3';
import CryptoJS  from 'crypto-js';
import axios     from 'axios';
import express   from 'express';
import crypto    from 'crypto';
import path      from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || '.';
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

// ═══════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════
const DB_FILE           = path.join(dataDir, 'at_community.db');
const ENCRYPTION_KEY    = process.env.ENCRYPTION_KEY || 'AT_Community_Secret_Key_2026_Bot!@#';
const PORT              = parseInt(process.env.PORT || '3000', 10);
const BASE_URL          = process.env.BASE_URL || `http://localhost:${PORT}`;
const OPENROUTER_MODEL  = 'openrouter/free';

// ═══════════════════════════════════════════════════════════════
//  COLORS
// ═══════════════════════════════════════════════════════════════
const COLOR_PRIMARY   = 0x5865F2;
const COLOR_SUCCESS   = 0x00FF00;
const COLOR_ERROR     = 0xFF0000;
const COLOR_INFO      = 0x00BFFF;
const COLOR_GOLD      = 0xFFD700;

// ═══════════════════════════════════════════════════════════════
//  CHAT SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════
const CHAT_SYSTEM_PROMPT =
    "You are Orion, the smart assistant for AT COMMUNITY. " +
    "IMPORTANT RULES: " +
    "1) Never mention your model name, AI provider, or any technical backend details. " +
    "2) You are simply Orion — your name is Orion. " +
    "3) If asked what model you are, always say 'I am Orion, the assistant of AT COMMUNITY' and nothing else about AI. " +
    "4) Never apologize for being an AI. " +
    "5) Respond in a helpful, encouraging, technical tone. Keep responses concise and accurate.";

const JUDGE_PROMPT =
    "You are a strict code judge in AT COMMUNITY.\n" +
    "Evaluate the user's code against the problem statement and expected output.\n" +
    "If the code correctly solves the problem and produces the expected output, start your response with [SUCCESS] then briefly explain why.\n" +
    "If the code is wrong, start your response with [FAIL] then explain where the error is and how to think about fixing it WITHOUT giving the actual code.";

// ═══════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════
let db;

function initDb() {
    db = new Database(DB_FILE);

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            discord_id          TEXT PRIMARY KEY,
            api_key             TEXT,
            score               INTEGER DEFAULT 0,
            total_submissions   INTEGER DEFAULT 0,
            correct_submissions INTEGER DEFAULT 0,
            created_at          TEXT DEFAULT (datetime('now'))
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS chat_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            discord_id  TEXT NOT NULL,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL,
            created_at  TEXT DEFAULT (datetime('now'))
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS challenge_questions (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            title            TEXT NOT NULL,
            problem_statement TEXT NOT NULL,
            difficulty       TEXT DEFAULT 'medium',
            expected_output  TEXT,
            created_by       TEXT,
            created_at       TEXT DEFAULT (datetime('now'))
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS submissions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            discord_id    TEXT NOT NULL,
            question_id   INTEGER NOT NULL,
            code          TEXT NOT NULL,
            result        TEXT,
            submitted_at  TEXT DEFAULT (datetime('now'))
        )
    `);

    db.exec(`UPDATE users SET api_key = NULL`);
    console.log('  🔄 All user API keys cleared — users must re-register');

    db.exec(`DELETE FROM chat_history`);
    console.log('  🔄 All chat history cleared on startup');

    console.log('  📦 AT Community → DB initialized');
}

// ═══════════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════
function encryptKey(text) {
    return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
}

function decryptKey(ciphertext) {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
}

function isAdmin(userId) {
    const adminIds = (process.env.ADMIN_IDS || process.env.OWNER_IDS || '')
        .split(',').map(id => id.trim());
    return adminIds.includes(userId);
}

function splitMessage(text, maxLength = 1900) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }
        let splitIdx = remaining.lastIndexOf('\n', maxLength);
        if (splitIdx <= 0) splitIdx = maxLength;
        chunks.push(remaining.substring(0, splitIdx));
        remaining = remaining.substring(splitIdx).trimStart();
    }
    return chunks;
}

async function callOpenRouter(apiKey, messages, model = OPENROUTER_MODEL, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                { model, messages, max_tokens: 2048, temperature: 0.7 },
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'HTTP-Referer': 'https://at-community.com',
                        'X-Title': 'AT COMMUNITY Bot',
                        'Content-Type': 'application/json',
                    }
                }
            );
            return { success: true, text: response.data.choices[0].message.content };
        } catch (error) {
            const errData = error.response?.data?.error;
            console.error(`OpenRouter error (attempt ${attempt}/${retries}):`, JSON.stringify(errData || error.message));

            if (errData?.code === 429 && attempt < retries) {
                const wait = (errData.metadata?.retry_after_seconds || 5) * 1000;
                console.log(`Rate limited, retrying in ${wait / 1000}s...`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }

            return {
                success: false,
                error: errData?.message || error.message || 'Connection error or quota exhausted.'
            };
        }
    }
}

// Each user MUST register their own key — no shared bot key fallback
function getUserApiKey(userId) {
    const row = db.prepare('SELECT api_key FROM users WHERE discord_id = ?').get(userId);
    if (row?.api_key) {
        return decryptKey(row.api_key);
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════
//  OAUTH SERVER
// ═══════════════════════════════════════════════════════════════
const pendingOAuth = new Map();

function base64url(buffer) {
    return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createOAuthSession(discordUserId, baseUrlOverride) {
    const url = baseUrlOverride || BASE_URL;
    const state = crypto.randomBytes(16).toString('hex');
    const codeVerifier = base64url(crypto.randomBytes(32));

    pendingOAuth.set(state, {
        codeVerifier,
        discordUserId,
        createdAt: Date.now(),
    });

    for (const [key, val] of pendingOAuth) {
        if (Date.now() - val.createdAt > 10 * 60 * 1000) {
            pendingOAuth.delete(key);
        }
    }

    const codeChallenge = base64url(
        crypto.createHash('sha256').update(codeVerifier).digest()
    );

    const authUrl = `https://openrouter.ai/auth?${new URLSearchParams({
        callback_url: `${url}/auth/callback`,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
    })}`;

    return { authUrl, state };
}

function startOAuthServer() {
    const app = express();
    app.use(express.json());

    app.get('/', (_req, res) => {
        res.json({ status: 'ok', service: 'AT COMMUNITY OAuth Server' });
    });

    app.get('/auth/callback', async (req, res) => {
        const { code, state } = req.query;

        if (!code || !state) {
            return res.status(400).send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:50px">
                    <h2 style="color:red">Error</h2>
                    <p>Missing code or state parameter.</p>
                </body></html>
            `);
        }

        const session = pendingOAuth.get(state);
        if (!session) {
            return res.status(400).send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:50px">
                    <h2 style="color:red">Error</h2>
                    <p>Invalid or expired session. Please try again with /link in Discord.</p>
                </body></html>
            `);
        }

        pendingOAuth.delete(state);

        try {
            const response = await axios.post(
                'https://openrouter.ai/api/v1/auth/keys',
                {
                    code,
                    code_verifier: session.codeVerifier,
                    code_challenge_method: 'S256',
                },
                { headers: { 'Content-Type': 'application/json' } }
            );

            const apiKey = response.data.key;
            if (!apiKey) throw new Error('No key returned from OpenRouter');

            const encrypted = encryptKey(apiKey);
            db.prepare(
                `INSERT INTO users (discord_id, api_key) VALUES (?, ?)
                 ON CONFLICT(discord_id) DO UPDATE SET api_key = excluded.api_key`
            ).run(session.discordUserId, encrypted);

            res.send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#1a1a2e;color:white">
                    <h2 style="color:#00ff88">Account Linked Successfully!</h2>
                    <p>Your OpenRouter API key has been saved.</p>
                    <p>Go back to Discord and start chatting with Orion!</p>
                    <p style="color:#666;margin-top:30px">You can close this tab.</p>
                </body></html>
            `);

            console.log(`  ✅ OAuth completed for Discord user ${session.discordUserId}`);
        } catch (error) {
            console.error('  ❌ OAuth exchange failed:', error.response?.data || error.message);
            res.send(`
                <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#1a1a2e;color:white">
                    <h2 style="color:red">Error</h2>
                    <p>Failed to complete authentication. Please try again with /link in Discord.</p>
                    <p style="color:#666">${error.response?.data?.error?.message || error.message}</p>
                </body></html>
            `);
        }
    });

    function keepAlive() {
        setTimeout(async () => {
            try { await axios.get(BASE_URL); } catch {}
            keepAlive();
        }, 4 * 60 * 1000);
    }
    keepAlive();

    return new Promise((resolve) => {
        app.listen(PORT, () => {
            console.log(`  🌐 OAuth server running on ${BASE_URL}`);
            resolve();
        });
    });
}

// ═══════════════════════════════════════════════════════════════
//  SLASH COMMANDS
// ═══════════════════════════════════════════════════════════════

// ── /link ──
const linkCommand = {
    data: new SlashCommandBuilder()
        .setName('link')
        .setDescription('Link your OpenRouter account via Google sign-in (no API key needed)'),

    async execute(interaction) {
        const { authUrl } = createOAuthSession(interaction.user.id);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('🔗 Link Account')
                .setURL(authUrl)
                .setStyle(ButtonStyle.Link)
        );

        await interaction.reply({
            embeds: [
                new EmbedBuilder()
                    .setTitle('🔗 Link your OpenRouter account')
                    .setDescription(
                        'Click the button below to sign in with Google and connect your OpenRouter account.\n\n' +
                        'The link expires in **10 minutes**.'
                    )
                    .setColor(COLOR_PRIMARY)
                    .setTimestamp()
            ],
            components: [row],
            ephemeral: true,
        });
    }
};

// ── /help (unified, context-aware) ──
const helpCommand = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show all available commands'),

    async execute(interaction) {
        const admin = isAdmin(interaction.user.id);

        const fields = [];

        // ── User commands (everyone) ──
        fields.push({
            name: '💬 Chat & Setup',
            value:
                '`/link` — Link your OpenRouter account via Google\n' +
                '`/profile` — View your stats',
        });
        fields.push({
            name: '🏆 Challenges',
            value:
                '`/challenges` — List available challenges\n' +
                '`/submit` — Submit code for a challenge\n' +
                '`/leaderboard` — Top scorers\n' +
                '`/mysubmissions` — Your recent submissions',
        });
        fields.push({
            name: '🎫 Tickets',
            value:
                '`/ticket` — Open or view your ticket',
        });
        fields.push({
            name: '🔒 Private Categories',
            value:
                '`/panel` — Private category control panel',
        });

        // ── Admin commands ──
        if (admin) {
            fields.push({
                name: '🛠️ Admin — Community',
                value:
                    '`/addquestion` — Add a new challenge\n' +
                    '`/resetkeys` — Clear all user API keys',
            });
            fields.push({
                name: '🛡️ Security',
                value:
                    '`/security` — Open AT Security control panel',
            });
            fields.push({
                name: '⚙️ Tickets — Admin',
                value:
                    '`/ticket-admin` — Ticket system setup\n' +
                    '`/ticket-manage` — Manage current ticket\n' +
                    '`/ticket-stats` — Ticket statistics',
            });
            fields.push({
                name: '📂 Private Categories — Admin',
                value:
                    '`/admin` — Manage private categories & settings',
            });
            fields.push({
                name: '👋 Welcome System',
                value:
                    '`/setwelcome` — Set welcome channel\n' +
                    '`/setgoodbye` — Set goodbye channel\n' +
                    '`/setwelcomemsg` — Set welcome message\n' +
                    '`/setgoodbyemsg` — Set goodbye message\n' +
                    '`/welcomepreview` — Preview welcome\n' +
                    '`/goodbyepreview` — Preview goodbye\n' +
                    '`/resetwelcome` — Reset welcome settings',
            });
            fields.push({
                name: '🔨 Moderation',
                value:
                    '`/ban` — Ban a member\n' +
                    '`/kick` — Kick a member\n' +
                    '`/warn` — Warn a member\n' +
                    '`/unwarn` — Remove a warning\n' +
                    '`/mute` — Mute a member\n' +
                    '`/unmute` — Unmute a member\n' +
                    '`/timeout` — Timeout a member\n' +
                    '`/untimeout` — Remove timeout\n' +
                    '`/jail` — Jail a member\n' +
                    '`/unjail` — Unjail a member\n' +
                    '`/softban` — Softban (ban + purge)\n' +
                    '`/striprole` — Strip a single role\n' +
                    '`/striproles` — Strip all roles\n' +
                    '`/nuke` — Mass ban',
            });
            fields.push({
                name: '📋 Moderation — Info & Config',
                value:
                    '`/warnings` — View warnings\n' +
                    '`/resetwarns` — Reset warnings\n' +
                    '`/punishmenthistory` — Punishment log\n' +
                    '`/lookup` — Look up user info\n' +
                    '`/setpunishlog` — Set punish log channel\n' +
                    '`/setbotowner` — Set bot owner\n' +
                    '`/reloadconfig` — Reload config\n' +
                    '`/setroleban` — Set ban role\n' +
                    '`/setrolemute` — Set mute role\n' +
                    '`/setrolejail` — Set jail role\n' +
                    '`/setrolekick` — Set kick role',
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('🤖 AT COMMUNITY — All Commands')
            .setColor(COLOR_PRIMARY)
            .addFields(fields)
            .setFooter({
                text: admin
                    ? 'Showing all commands (Admin) • AT COMMUNITY'
                    : 'Showing user commands only • AT COMMUNITY',
            })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};

// ── /profile ──
const profileCommand = {
    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Show your stats profile'),

    async execute(interaction) {
        const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(interaction.user.id);

        if (!user) {
            return interaction.reply({
                content: 'No profile yet. Use `/link` to connect your account first.',
                ephemeral: true,
            });
        }

        const accuracy = user.total_submissions > 0
            ? Math.round((user.correct_submissions / user.total_submissions) * 100)
            : 0;

        const rankEmoji =
            user.score >= 100 ? '💎 Diamond' :
            user.score >= 50  ? '🥇 Gold' :
            user.score >= 20  ? '🥈 Silver' :
            user.score > 0    ? '🥉 Bronze' : '🌱 Newcomer';

        const embed = new EmbedBuilder()
            .setTitle(`${interaction.user.username}'s Profile`)
            .setColor(COLOR_PRIMARY)
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .addFields(
                { name: 'Score',      value: `${user.score} pts`,                      inline: true },
                { name: 'Rank',       value: rankEmoji,                                 inline: true },
                { name: 'Accuracy',   value: `${accuracy}%`,                            inline: true },
                { name: 'Submissions', value: `${user.correct_submissions}/${user.total_submissions}`, inline: true },
                { name: 'API Key',    value: user.api_key ? '✅ Set' : '❌ Not set',   inline: true },
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};

// ── /challenges ──
const challengesCommand = {
    data: new SlashCommandBuilder()
        .setName('challenges')
        .setDescription('List all available coding challenges'),

    async execute(interaction) {
        const questions = db.prepare('SELECT * FROM challenge_questions ORDER BY id ASC').all();

        if (questions.length === 0) {
            return interaction.reply({
                content: 'No challenges yet. Ask an admin to add some with `/addquestion`.',
                ephemeral: true,
            });
        }

        const emoji = { easy: '🟢', medium: '🟡', hard: '🔴' };

        const list = questions.map(q =>
            `**#${q.id}** ${emoji[q.difficulty] || '⚪'} ${q.title}`
        ).join('\n');

        const embed = new EmbedBuilder()
            .setTitle('📋 Available Coding Challenges')
            .setColor(COLOR_INFO)
            .setDescription(list)
            .setFooter({ text: `Total: ${questions.length} | Use /submit to solve` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};

// ── /submit ──
const submitCommand = {
    data: new SlashCommandBuilder()
        .setName('submit')
        .setDescription('Submit code for a programming challenge')
        .addIntegerOption(opt =>
            opt.setName('question_id').setDescription('Question ID number').setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('code').setDescription('Your code solution').setRequired(true)
        ),

    async execute(interaction) {
        const questionId = interaction.options.getInteger('question_id');
        const userCode   = interaction.options.getString('code');

        const question = db.prepare('SELECT * FROM challenge_questions WHERE id = ?').get(questionId);
        if (!question) {
            return interaction.reply({ content: 'Invalid question ID.', ephemeral: true });
        }

        const rawApiKey = getUserApiKey(interaction.user.id);
        if (!rawApiKey) {
            return interaction.reply({
                content: 'Link your account first with `/link` to get an API key.',
                ephemeral: true,
            });
        }

        await interaction.deferReply();

        const promptMessages = [
            { role: 'system', content: JUDGE_PROMPT },
            {
                role: 'user',
                content:
                    `Problem: ${question.title}\n\n` +
                    `${question.problem_statement}\n\n` +
                    `Expected Output: ${question.expected_output}\n\n` +
                    `User Code:\n\`\`\`\n${userCode}\n\`\`\``,
            },
        ];

        const aiResult = await callOpenRouter(rawApiKey, promptMessages);

        if (!aiResult.success) {
            return interaction.editReply(`Evaluation failed: ${aiResult.error}`);
        }

        const isCorrect = aiResult.text.includes('[SUCCESS]');

        db.prepare(
            'UPDATE users SET total_submissions = total_submissions + 1, correct_submissions = correct_submissions + ? WHERE discord_id = ?'
        ).run(isCorrect ? 1 : 0, interaction.user.id);

        db.prepare(
            'INSERT INTO submissions (discord_id, question_id, code, result) VALUES (?, ?, ?, ?)'
        ).run(interaction.user.id, questionId, userCode, isCorrect ? 'SUCCESS' : 'FAIL');

        const cleanFeedback = aiResult.text.replace('[SUCCESS]', '').replace('[FAIL]', '').trim();

        if (isCorrect) {
            db.prepare('UPDATE users SET score = score + 10 WHERE discord_id = ?').run(interaction.user.id);

            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('✅ Correct Answer!')
                        .setColor(COLOR_SUCCESS)
                        .setDescription(cleanFeedback)
                        .addFields(
                            { name: 'Question',      value: question.title, inline: true },
                            { name: 'Points Earned', value: '+10',          inline: true },
                        )
                        .setTimestamp(),
                ],
            });
        } else {
            return interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle('❌ Incorrect Attempt')
                        .setColor(COLOR_ERROR)
                        .setDescription(cleanFeedback)
                        .addFields({ name: 'Question', value: question.title, inline: true })
                        .setTimestamp(),
                ],
            });
        }
    }
};

// ── /leaderboard ──
const leaderboardCommand = {
    data: new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show top scorers leaderboard'),

    async execute(interaction) {
        const topUsers = db.prepare(
            'SELECT discord_id, score, correct_submissions, total_submissions FROM users WHERE score > 0 ORDER BY score DESC LIMIT 10'
        ).all();

        if (topUsers.length === 0) {
            return interaction.reply({
                content: 'No one is on the leaderboard yet.',
                ephemeral: true,
            });
        }

        const medals = ['🥇 First', '🥈 Second', '🥉 Third'];

        const entries = topUsers.map((u, i) => {
            const medal = i < 3 ? medals[i] : `#${i + 1}`;
            const accuracy = u.total_submissions > 0
                ? Math.round((u.correct_submissions / u.total_submissions) * 100)
                : 0;
            return `**${medal}** — <@${u.discord_id}> — **${u.score}** pts (${accuracy}% accuracy, ${u.correct_submissions}/${u.total_submissions})`;
        });

        const embed = new EmbedBuilder()
            .setTitle('🏆 Leaderboard')
            .setColor(COLOR_GOLD)
            .setDescription(entries.join('\n\n'))
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};

// ── /mysubmissions ──
const mysubmissionsCommand = {
    data: new SlashCommandBuilder()
        .setName('mysubmissions')
        .setDescription('Show your recent submissions'),

    async execute(interaction) {
        const submissions = db.prepare(
            `SELECT s.*, c.title FROM submissions s
             LEFT JOIN challenge_questions c ON s.question_id = c.id
             WHERE s.discord_id = ?
             ORDER BY s.submitted_at DESC LIMIT 10`
        ).all(interaction.user.id);

        if (submissions.length === 0) {
            return interaction.reply({
                content: 'No submissions yet. Try a challenge with `/submit`!',
                ephemeral: true,
            });
        }

        const list = submissions.map(s => {
            const emoji = s.result === 'SUCCESS' ? '✅' : '❌';
            return `${emoji} **${s.title || 'Unknown'}** — <t:${Math.floor(new Date(s.submitted_at).getTime() / 1000)}:R>`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setTitle(`${interaction.user.username}'s Recent Submissions`)
            .setColor(COLOR_PRIMARY)
            .setDescription(list)
            .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
};

// ── /addquestion (admin only) ──
const addquestionCommand = {
    data: new SlashCommandBuilder()
        .setName('addquestion')
        .setDescription('Add a coding challenge (Admin only)')
        .addStringOption(opt =>
            opt.setName('title').setDescription('Challenge title').setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('problem').setDescription('Problem statement').setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('expected_output').setDescription('Expected output').setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('difficulty').setDescription('Difficulty level')
                .addChoices(
                    { name: 'Easy', value: 'easy' },
                    { name: 'Medium', value: 'medium' },
                    { name: 'Hard', value: 'hard' },
                )
        ),

    async execute(interaction) {
        if (!isAdmin(interaction.user.id)) {
            return interaction.reply({ content: 'This command is admin-only.', ephemeral: true });
        }

        const title          = interaction.options.getString('title');
        const problem        = interaction.options.getString('problem');
        const expectedOutput = interaction.options.getString('expected_output');
        const difficulty     = interaction.options.getString('difficulty') || 'medium';

        const result = db.prepare(
            'INSERT INTO challenge_questions (title, problem_statement, expected_output, difficulty, created_by) VALUES (?, ?, ?, ?, ?)'
        ).run(title, problem, expectedOutput, difficulty, interaction.user.id);

        const embed = new EmbedBuilder()
            .setTitle('✅ New Challenge Added')
            .setColor(COLOR_INFO)
            .addFields(
                { name: 'ID',             value: String(result.lastInsertRowid), inline: true },
                { name: 'Title',          value: title,                          inline: true },
                { name: 'Difficulty',     value: difficulty,                     inline: true },
                { name: 'Problem',        value: problem.substring(0, 1024) },
                { name: 'Expected Output', value: expectedOutput.substring(0, 1024) },
            )
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    }
};

// ── /resetkeys (admin only) ──
const resetkeysCommand = {
    data: new SlashCommandBuilder()
        .setName('resetkeys')
        .setDescription('Clear all user API keys — forces everyone to re-register (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        if (!isAdmin(interaction.user.id)) {
            return interaction.reply({ content: 'This command is admin-only.', ephemeral: true });
        }

        const result = db.prepare('UPDATE users SET api_key = NULL').run();
        const count = result.changes;

        const embed = new EmbedBuilder()
            .setTitle('🔄 All API Keys Cleared')
            .setDescription(`Successfully wiped **${count}** user API key(s). All users must re-link via \`/link\`.`)
            .setColor(COLOR_SUCCESS)
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        console.log(`  🔄 [ADMIN] ${interaction.user.tag} cleared all API keys (${count} affected)`);
    }
};

// ═══════════════════════════════════════════════════════════════
//  ORION AI CHAT HANDLER (messageCreate)
// ═══════════════════════════════════════════════════════════════
async function handleOrionChat(message, client) {
    try {
    if (message.author.bot) return;

    // Ignore DMs — only respond in server
    if (!message.guild) return;

    const isMentioned = message.mentions.has(client.user);
    const isBotChannel = message.channel.type === 0 && message.channel.name === 'bot-chat';

    if (!isMentioned && !isBotChannel) return;

    const userId = message.author.id;
    console.log(`  💬 Orion message received from ${message.author.tag} (${userId})`);

    await message.channel.sendTyping();

    const rawApiKey = getUserApiKey(userId);
    if (!rawApiKey) {
        return message.reply('No API key available. Use `/link` to connect your OpenRouter account via Google.');
    }

    // Clean up old history — keep only last 50 messages per user
    db.prepare(
        `DELETE FROM chat_history WHERE discord_id = ? AND id NOT IN (
            SELECT id FROM chat_history WHERE discord_id = ? ORDER BY id DESC LIMIT 50
        )`
    ).run(userId, userId);

    const history = db.prepare(
        'SELECT role, content FROM chat_history WHERE discord_id = ? ORDER BY id DESC LIMIT 15'
    ).all(userId);
    history.reverse();

    const cleanContent = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
        .trim();

    if (!cleanContent) return;

    const payloadMessages = [
        { role: 'system', content: CHAT_SYSTEM_PROMPT },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: cleanContent },
    ];

    const response = await callOpenRouter(rawApiKey, payloadMessages);

    if (!response.success) {
        console.error(`  ❌ Orion AI error for ${userId}: ${response.error}`);
        return message.reply(`Error: ${response.error}`);
    }

    db.prepare('INSERT INTO chat_history (discord_id, role, content) VALUES (?, ?, ?)').run(userId, 'user', cleanContent);
    db.prepare('INSERT INTO chat_history (discord_id, role, content) VALUES (?, ?, ?)').run(userId, 'assistant', response.text);

    const chunks = splitMessage(response.text);
    for (const chunk of chunks) {
        await message.reply(chunk);
    }
    console.log(`  ✅ Orion reply sent to ${message.author.tag} (${chunks.length} chunk(s))`);
    } catch (err) {
        console.error('  ❌ handleOrionChat CRASH:', err.message, err.stack);
        try { await message.reply('⚠️ An error occurred while processing your message. Please try again later.'); } catch {}
    }
}

// ═══════════════════════════════════════════════════════════════
//  SETUP FUNCTION — Called by index.js loader
// ═══════════════════════════════════════════════════════════════
export async function setup(client) {
    initDb();

    client.slashCommands.set('link',           linkCommand);
    client.slashCommands.set('help',           helpCommand);
    client.slashCommands.set('profile',        profileCommand);
    client.slashCommands.set('challenges',     challengesCommand);
    client.slashCommands.set('submit',         submitCommand);
    client.slashCommands.set('leaderboard',    leaderboardCommand);
    client.slashCommands.set('mysubmissions',  mysubmissionsCommand);
    client.slashCommands.set('addquestion',    addquestionCommand);
    client.slashCommands.set('resetkeys',      resetkeysCommand);

    client.on('messageCreate', (msg) => handleOrionChat(msg, client));
    console.log('  📡 [AT Community] messageCreate listener registered');

    try {
        await startOAuthServer();
    } catch (err) {
        console.error('  ❌ OAuth server failed to start:', err.message);
    }

    console.log('  ✅ AT Community Cog → loaded');
}
