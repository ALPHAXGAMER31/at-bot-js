# PROJECT_MAP.md — AT-BOT
> Last updated: 2026-09-20 | Status: CLEAN | Maintainer: iam.alpha

---

## TECH_STACK

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 18+ (ESM) |
| Discord API | discord.js | ^14.26.5 |
| Database | better-sqlite3 | ^12.11.1 |
| Canvas | @napi-rs/canvas | ^1.0.8 |
| HTTP Server | express | ^4.21.2 (keep-alive, health on /) |
| HTTP Client | axios | ^1.7.9 |
| Crypto | crypto-js | ^4.2.0 |
| Env | dotenv | ^16.4.5 |
| Dev | nodemon | ^3.1.0 |

---

## ARCHITECTURE

```
Entry: index.js
├── Bootstrap (auto npm install check)
├── Client creation (6 intents)
├── Cog loader (cogs/*.js → setup(client))
├── Slash command syncer (REST API)
├── Event routing (InteractionCreate, MessageCreate)
├── HTTP Keep-Alive server (express → /, prevents Render free-tier sleep)
│
├── Config: config.js ← .env
│
├── Shared Lib:
│   ├── lib/embeds.js   — Embed helper functions (makeEmbed, successEmbed, etc.)
│   ├── lib/logger.js   — Centralized logging (createLogger)
│   └── lib/db.js       — Database helper (getDb)
│
├── Docs:
│   ├── PROJECT_MAP.md  — Architecture map (for developers)
│   └── USER_GUIDE.md   — User guide (for users, Arabic)
│
└── Cogs (Domain-Driven Modules):
    ├── private_categories.js  [~1042 lines] → private_categories.db
    ├── tickets.js             [~1434 lines] → tickets.db
    ├── security.js            [~1159 lines] → security.db
    ├── punisher.js            [~772 lines]  → punisher.db
    ├── at_community.js        [~777 lines]  → at_community.db
    ├── welcome.js             [~352 lines]  → welcome.db
    ├── logger.js              [  93 lines]  → logger.db
    ├── backup.js              [ 206 lines]  → /export + /import + /restart + daily DM backup
    ├── roles_manager.js       [~137 lines]  → data/roles.sqlite
    ├── verification_sync.js   [  71 lines]  → verification_data.db
    ├── example.js             [  29 lines]  → (template cog, /ping)
    └── keep_alive.js          [  22 lines]  → (configurable via env)
```

---

## SYSTEM_FLOW

```
Discord Gateway ←→ Client (index.js)
    │
    ├── InteractionCreate (slash) → client.slashCommands.get(name).execute()
    ├── InteractionCreate (button/modal/select) → client.emit('componentInteraction')
    │   ├── private_categories → pc_* handlers
    │   ├── tickets → tk_* handlers
    │   ├── security → sec_* handlers
    │   ├── punisher → dash_*, pardon_*, clear_* handlers
    │   └── roles_manager → roles_* handlers (via interactionCreate direct)
    │
    ├── MessageCreate (!prefix) → client.commands.get(name).execute()
    │   └── !check command (built-in)
    │
    ├── GuildMemberAdd → welcome.js (image gen) + security.js (verify)
    ├── GuildMemberUpdate → punisher.js (role restore) + verification_sync.js (freeze/unfreeze)
    ├── ChannelCreate/Delete/Update → security.js (anti-nuke)
    ├── GuildRoleCreate/Delete/Update → security.js (anti-nuke)
    └── Background intervals:
        ├── punisher: check_punishments (15s) + auto_refresh_logs (5min)
        ├── security: nuke cleanup (15s) + beast mode (5min) + save originals (6h)
        ├── backup: daily DM backup to owners (24h, first run at 2min)
        └── keep_alive: heartbeat (24h, configurable)
```

---

## DATABASE_MAP

| File | Module | Tables |
|------|--------|--------|
| `private_categories.db` | private_categories.js | private_categories, private_logs, private_config |
| `punisher.db` | punisher.js | punishments, warnings, bot_owners, punishment_history, log_messages, pardon_requests |
| `security.db` | security.js | settings, whitelist, logs, verifications |
| `tickets.db` | tickets.js | ticket_config, tickets, ticket_messages, ticket_blacklist, support_teams |
| `data/roles.sqlite` | roles_manager.js | whitelist |
| `verification_data.db` | verification_sync.js | frozen_roles |
| `at_community.db` | at_community.js | users, chat_history, challenge_questions, submissions |
| `logger.db` | logger.js | log_settings |
| `welcome.db` | welcome.js | welcome |

---

## SLASH_COMMANDS

| Command | Module | Permission | Description |
|---------|--------|------------|-------------|
| `/panel` | private_categories | Everyone | Private categories control panel |
| `/admin` | private_categories | Administrator | Admin panel for categories |
| `/ticket` | tickets | Everyone | User ticket panel |
| `/ticket-manage` | tickets | ManageChannels | Manage current ticket |
| `/ticket-admin` | tickets | Administrator | Ticket system setup |
| `/ticket-stats` | tickets | ManageChannels | Ticket statistics |
| `/punisher` | punisher | Administrator | Punishment control hub |
| `/punisher_status` | punisher | Everyone (own file) | View punishment status |
| `/make_owner` | punisher | Bot Owner Only | Add system owner |
| `/security` | security | Owner Only | Security dashboard |
| `/export` | backup | Owner Only | Export full DB/settings backup to DM |
| `/import` | backup | Owner Only | Restore a backup (.gz) into the DBs |
| `/restart` | backup | Owner Only | Restart the bot (Render auto-restarts) |
| `/roles manage` | roles_manager | Owner/Whitelist | Role management UI |
| `/roles view-role` | roles_manager | Everyone | Analyze role permissions |
| `/setup-welcome` | welcome | Administrator | Welcome system config |

---

## ORPHANS & PENDING

| Item | Status | Action Taken |
|------|--------|--------------|
| `cogs/bootstrap.js` | Orphan — no `setup()` | ✅ DELETED |
| `keep_alive.js` | Broken — placeholder channel ID | ✅ FIXED — configurable via env |
| `node-fetch` | Unused dependency | ✅ REMOVED |
| `@distube/soundcloud` | Unused (no music cogs) | ✅ REMOVED |
| `@distube/youtube` | Deprecated, replaced by @distube/yt-dlp | ✅ REPLACED |
| `@distube/yt-dlp` | Uses system yt-dlp binary via pip | ✅ Installed |
| `@distube/soundcloud` | SoundCloud plugin | ✅ Installed |
| `queue.guild.id` | DisTube v5 Queue has no `.guild` property | ✅ FIXED — use `queue.id` |
| Search queries | YtDlpPlugin has no `searchSong()` | ✅ FIXED — yt-dlp CLI search before play |
| `@distube/yt-dlp` json() | Mixes stdout+stderr | ✅ PATCHED via postinstall script |
| `mediaplex` | Unused | ✅ REMOVED |
| `ytdl-core` | Deprecated | ✅ REMOVED |
| `@napi-rs/canvas` | Unused (welcome.js uses `canvas`) | ✅ REMOVED |
| `fonts/` | Unused — no code loads fonts | ✅ DELETED |
| SQL Injection (C1) | Critical security flaw | ✅ FIXED — whitelist validation |
| `.env` protection | Missing .gitignore | ✅ FIXED — .gitignore created |
| `guild.roles.everyone` | Missing `.id` (punisher + security) | ✅ FIXED |
| Embed helpers duplication | Repeated in 2 files | ✅ EXTRACTED to lib/embeds.js |
| `welcome.js` global listener | Intercepts all interactions | ✅ FIXED — scoped to own IDs |
| `index.js` monkey-patch | Modifies EmbedBuilder.prototype.toJSON | ✅ REMOVED |
| `security.js` unused return | setup() returns unused object | ✅ REMOVED |
| Dual canvas libraries | canvas + @napi-rs/canvas | ✅ FIXED — removed @napi-rs/canvas |
| Footer string artifact | `\n\n` in punisher.js footer | ✅ FIXED |
| Unused imports | readFileSync, EmbedBuilder, ChannelType | ✅ REMOVED |
| `/make_owner` no API permission | Missing setDefaultMemberPermissions | ✅ FIXED — Admin only |
| `/security` no API permission | Missing default_member_permissions | ✅ FIXED — Admin only |
| `/roles` no API permission | Missing setDefaultMemberPermissions | ✅ FIXED — Admin only |
| `@distube/youtube` | Removed, replaced by @distube/yt-dlp | ✅ Replaced |
| `@distube/soundcloud` | Removed, re-added for music.js | ✅ Re-installed |
| music.js + DisTube stack | No music cog in cogs/ — phantom map entries | ✅ Removed from map |
| @napi-rs/canvas | In use (welcome.js image gen) | ℹ️ Map corrected |

---

## KNOWN_ISSUES (RESOLVED)

1. **C1** — `security.js` SQL injection → ✅ Fixed with whitelist validation
2. **C2** — `guild.roles.everyone` missing `.id` → ✅ Fixed in punisher.js + security.js
3. **C3** — `.env` unprotected → ✅ Fixed with .gitignore
4. **M1** — `keep_alive.js` placeholder → ✅ Fixed, configurable via env
5. **M2** — `bootstrap.js` misplaced → ✅ Deleted
6. **M3** — `security.js` unused return → ✅ Removed
7. **M4** — `welcome.js` global listener → ✅ Scoped to own customIds
8. **M5** — `index.js` monkey-patch → ✅ Removed
9. **M6** — Dual canvas → ✅ Removed @napi-rs/canvas
10. **M7** — DB files scattered → ℹ️ Each cog owns its DB (by design); lib/db.js available for new modules
11. **M8** — Duplicate embed helpers → ✅ Extracted to lib/embeds.js
12. **M9** — Footer string artifacts → ✅ Fixed
13. **M10** — Unused npm dependencies → ✅ Removed 7 packages
14. **M11** — Unused imports → ✅ Removed (readFileSync, EmbedBuilder, ChannelType)
15. **M12** — fonts/ directory unused → ✅ Deleted

---

## CLEAN_STATE

```
✅ 14/14 source files pass node --check
✅ 0 TODO/FIXME/PLACEHOLDER in source code
✅ 0 unused imports across all files
✅ 0 orphan files or dead code
✅ .gitignore protecting secrets + DB files
✅ SQL injection patched
✅ All shared libs created (embeds, logger, db)
✅ HTTP Keep-Alive server (express → / — prevents Render free-tier sleep)
✅ Backup system (cogs/backup.js — /export + /import + /restart + daily DM backup to owners)
✅ Permission audit complete (all admin commands restricted at API level)
✅ PROJECT_MAP.md is current
```

### FUTURE_IMPROVEMENTS (optional, not blocking)
- Migrate cogs from `console.log` to `lib/logger.js` (structured logging)
- Adopt `lib/db.js` `getDb()` in existing cogs (currently each cog inits its own DB)
- External pinger (e.g. UptimeRobot, ~5min) on the Render URL to guarantee zero spin-down
- Attach a Render disk (paid) if durable DB storage is needed without relying on DM backups
