import express from "express";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import si from "systeminformation";
import config from "./config.js";
import BaleClient from "./bale-client.js";
import { startBot } from "./bot-daemon.js";
import logger from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve static dashboard files from 'public' folder
app.use(express.static(path.join(__dirname, "public")));

/**
 * Authentication Middleware
 */
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    if (!authHeader) {
        return res.status(401).json({ error: "Unauthorized: Missing Authorization header" });
    }

    const token = authHeader.replace("Bearer ", "");
    if (token !== config.dashboardPassword) {
        return res.status(403).json({ error: "Forbidden: Invalid dashboard password" });
    }
    next();
};

/**
 * Auth validation endpoint
 */
app.post("/api/auth/verify", (req, res) => {
    const { password } = req.body;
    if (password === config.dashboardPassword) {
        return res.json({ success: true, token: config.dashboardPassword });
    }
    return res.status(401).json({ success: false, error: "Invalid password" });
});

/**
 * Get bot connection status and system info
 */
app.get("/api/status", authMiddleware, async (req, res) => {
    try {
        const serverUptime = os.uptime();

        // System information
        const cpuSpeed = await si.cpuCurrentSpeed();
        const cpuLoad = await si.currentLoad();
        const mem = await si.mem();
        const disk = await si.fsSize();

        // Find the disk where downloads are stored
        const downloadsDisk = disk.find((d) => config.downloadsDir.startsWith(d.mount)) || disk[0];

        // Bot connection status
        let botStatus = "Disconnected";
        let botInfo = null;
        if (!config.isPlaceholderToken) {
            try {
                const client = new BaleClient(config.token);
                botInfo = await client.getMe();
                botStatus = "Connected";
            } catch (err) {
                botStatus = `Error: ${err.message}`;
            }
        } else {
            botStatus = "Not Configured";
        }

        res.json({
            bot: {
                status: botStatus,
                info: botInfo,
                defaultChatId: config.defaultChatId,
                whitelistEnabled: config.allowedChatIds.length > 0,
            },
            system: {
                platform: os.platform(),
                release: os.release(),
                uptime: serverUptime,
                cpu: {
                    load: cpuLoad.currentLoad,
                    speed: cpuSpeed.avg || 0,
                },
                memory: {
                    total: mem.total,
                    active: mem.active,
                    available: mem.available,
                },
                disk: downloadsDisk
                    ? {
                          mount: downloadsDisk.mount,
                          size: downloadsDisk.size,
                          used: downloadsDisk.used,
                          available: downloadsDisk.available,
                          usePercent: downloadsDisk.use,
                      }
                    : null,
            },
            config: {
                downloadsDir: config.downloadsDir,
            },
        });
    } catch (err) {
        logger.error(`Error in /api/status endpoint: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/**
 * List files in downloads directory safely
 */
app.get("/api/files", authMiddleware, (req, res) => {
    const subDir = req.query.dir || "";
    const targetDir = path.resolve(config.downloadsDir, subDir);

    // Security check: ensure path stays within config.downloadsDir
    const relative = path.relative(config.downloadsDir, targetDir);
    const isSafe = targetDir === config.downloadsDir || (!relative.startsWith("..") && !path.isAbsolute(relative));

    if (!isSafe) {
        return res.status(403).json({ error: "Access Denied: Path traversal is forbidden" });
    }

    if (!fs.existsSync(targetDir)) {
        return res.status(404).json({ error: "Directory not found" });
    }

    try {
        const files = fs.readdirSync(targetDir);
        const result = [];

        for (const filename of files) {
            if (config.ignoredFiles.has(filename)) continue;
            const filePath = path.join(targetDir, filename);
            const stats = fs.statSync(filePath);

            const relativePath = path.relative(config.downloadsDir, filePath).replace(/\\/g, "/");

            result.push({
                name: filename,
                relativePath: relativePath,
                isDir: stats.isDirectory(),
                size: stats.isDirectory() ? 0 : stats.size,
                modifiedAt: stats.mtime,
            });
        }

        // Sort: directories first, then alphabetical
        result.sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name);
        });

        res.json({
            currentPath: relative.replace(/\\/g, "/"),
            files: result,
        });
    } catch (err) {
        logger.error(`Error in /api/files endpoint: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Upload a local server file to Bale Chat
 */
app.post("/api/upload", authMiddleware, async (req, res) => {
    const { relativePath, chatId, caption, type } = req.body;

    if (!relativePath) {
        return res.status(400).json({ error: "Missing relativePath parameter" });
    }

    const resolvedPath = path.resolve(config.downloadsDir, relativePath);

    // Security check: ensure path stays within config.downloadsDir
    const relative = path.relative(config.downloadsDir, resolvedPath);
    const isSafe = !relative.startsWith("..") && !path.isAbsolute(relative);

    if (!isSafe) {
        return res.status(403).json({ error: "Access Denied: Path traversal is forbidden" });
    }

    if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
        return res.status(404).json({ error: "File not found on server" });
    }

    const targetChatId = chatId || config.defaultChatId;
    if (!targetChatId) {
        return res.status(400).json({ error: "No target Chat ID provided" });
    }

    if (config.isPlaceholderToken) {
        return res.status(500).json({ error: "Bale Bot is not configured with a valid token" });
    }

    const filename = path.basename(resolvedPath);
    logger.info(`Web API triggering upload of ${filename} to Chat ID: ${targetChatId}`);

    try {
        const client = new BaleClient(config.token);
        let result;

        if (type === "video") {
            result = await client.sendVideo(targetChatId, resolvedPath, caption || "");
        } else if (type === "document") {
            result = await client.sendDocument(targetChatId, resolvedPath, caption || "");
        } else {
            result = await client.sendFile(targetChatId, resolvedPath, caption || "");
        }

        logger.success(`Web API successfully uploaded ${filename} to Chat ID: ${targetChatId}`);
        res.json({ success: true, messageId: result.message_id });
    } catch (err) {
        logger.error(`Web API upload failed for ${filename}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/**
 * Retrieve execution logs
 */
app.get("/api/logs", authMiddleware, (req, res) => {
    res.json({ logs: logger.getLogs() });
});

// Fallback index.html router for SPA behavior
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start the Express server
app.listen(config.port, () => {
    logger.success(`Server Dashboard available at: http://localhost:${config.port}`);

    // Launch Bale bot daemon in the same process
    if (!config.isPlaceholderToken) {
        logger.info("Starting bot daemon along with Express server...");
        startBot().catch((err) => {
            logger.error(`Error starting bot daemon: ${err.message}`);
        });
    } else {
        logger.warn("⚠️ Bot daemon not started because BALE_BOT_TOKEN is the default placeholder.");
    }
});
