const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

let minLevel = LEVELS.debug;

function timestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level, module, msg) {
    if (LEVELS[level] < minLevel) return;
    const tag = COLORS[level] + `[${level.toUpperCase()}]` + RESET;
    console.log(`${timestamp()} ${tag} [${module}] ${msg}`);
}

export function createLogger(module) {
    return {
        debug: (msg) => log('debug', module, msg),
        info:  (msg) => log('info',  module, msg),
        warn:  (msg) => log('warn',  module, msg),
        error: (msg) => log('error', module, msg),
    };
}

export function setLogLevel(level) {
    minLevel = LEVELS[level] ?? LEVELS.info;
}
