const logHistory = [];
const MAX_LOGS = 100;

export const logger = {
    info(message) {
        const timestamp = new Date().toISOString();
        const formatted = `[INFO] ${timestamp}: ${message}`;
        console.log(`\x1b[36m${formatted}\x1b[0m`);
        this._addLog(formatted);
    },

    success(message) {
        const timestamp = new Date().toISOString();
        const formatted = `[SUCCESS] ${timestamp}: ${message}`;
        console.log(`\x1b[32m${formatted}\x1b[0m`);
        this._addLog(formatted);
    },

    warn(message) {
        const timestamp = new Date().toISOString();
        const formatted = `[WARN] ${timestamp}: ${message}`;
        console.warn(`\x1b[33m${formatted}\x1b[0m`);
        this._addLog(formatted);
    },

    error(message, stack = "") {
        const timestamp = new Date().toISOString();
        const formatted = `[ERROR] ${timestamp}: ${message}${stack ? `\n${stack}` : ""}`;
        console.error(`\x1b[31m${formatted}\x1b[0m`);
        this._addLog(formatted);
    },

    _addLog(line) {
        logHistory.push(line);
        if (logHistory.length > MAX_LOGS) {
            logHistory.shift();
        }
    },

    getLogs() {
        return logHistory;
    },
};

export default logger;
