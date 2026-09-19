import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const instances = new Map();

export function getDb(name, fileName = null) {
    if (instances.has(name)) return instances.get(name);
    const dbPath = join(PROJECT_ROOT, fileName ?? `${name}.db`);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = 10000');
    instances.set(name, db);
    return db;
}

export function closeAll() {
    for (const db of instances.values()) {
        try { db.close(); } catch {}
    }
    instances.clear();
}
