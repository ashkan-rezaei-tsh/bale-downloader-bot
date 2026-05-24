import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import si from "systeminformation";
import config from "./config.js";
import BaleClient from "./bale-client.js";
import logger from "./logger.js";

// Cache for mapping chat IDs to their last listed file paths (makes it easy to do /upload 1)
const lastFileListCache = new Map();

// Helper to format bytes to human readable sizes
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

// Format duration
function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (d > 0) parts.push(`${d} روز`);
    if (h > 0) parts.push(`${h} ساعت`);
    if (m > 0) parts.push(`${m} دقیقه`);
    parts.push(`${s} ثانیه`);
    return parts.join(" ");
}

// Bot daemon start timestamp
const startTime = Date.now();

export async function startBot() {
    if (config.isPlaceholderToken) {
        logger.error("Cannot start Bale Bot. BALE_BOT_TOKEN is not configured in .env.");
        return;
    }

    const client = new BaleClient(config.token);
    let botInfo;

    try {
        botInfo = await client.getMe();
        logger.success(`Successfully connected to Bale Bot API! Bot: @${botInfo.username} (ID: ${botInfo.id})`);
    } catch (err) {
        logger.error(`Failed to connect to Bale Bot API: ${err.message}. Retrying in 10s...`);
        setTimeout(startBot, 10000);
        return;
    }

    let offset = 0;
    logger.info("Bale Bot Daemon has started long polling for updates...");

    while (true) {
        try {
            const updates = await client.getUpdates(offset, 100, 30);
            for (const update of updates) {
                offset = update.update_id + 1;
                if (update.message) {
                    // Handle the message asynchronously so we don't block the polling loop
                    handleMessage(client, update.message).catch((err) => {
                        logger.error(`Error handling message: ${err.message}`, err.stack);
                    });
                }
            }
        } catch (err) {
            logger.error(`Polling loop encountered an error: ${err.message}`);
            // Wait 5 seconds before attempting to poll again to avoid spamming Bale servers
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
    }
}

async function handleMessage(client, message) {
    const chatId = message.chat.id;
    const text = message.text ? message.text.trim() : "";

    // Check authorization
    if (!config.isChatAllowed(chatId)) {
        logger.warn(`Unauthorized access attempt from Chat ID: ${chatId}. Message text: "${text}"`);
        // Reply with an access denied message if it's a private chat
        if (message.chat.type === "private") {
            await client.sendMessage(
                chatId,
                "❌ دسترسی غیرمجاز: شناسه چت شما برای استفاده از این ربات در سرور مجاز نیست.",
            );
        }
        return;
    }

    // Check if it is a command
    if (!text.startsWith("/")) {
        return;
    }

    const parts = text.split(" ");
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    logger.info(`Received command [${command}] from Chat ID: ${chatId}`);

    try {
        switch (command) {
            case "/start":
            case "/help":
                await handleHelp(client, chatId);
                break;
            case "/chatid":
                await client.sendMessage(chatId, `شناسه چت شما: \`${chatId}\``, { parse_mode: "Markdown" });
                break;
            case "/status":
                await handleStatus(client, chatId);
                break;
            case "/files":
                await handleFiles(client, chatId, args);
                break;
            case "/upload":
                await handleUpload(client, chatId, args);
                break;
            default:
                await client.sendMessage(
                    chatId,
                    `دستور ناشناخته: ${command}. برای دیدن تمامی دستورات در دسترس، /help را تایپ کنید.`,
                );
        }
    } catch (err) {
        logger.error(`Command [${command}] execution failed: ${err.message}`);
        await client.sendMessage(chatId, `❌ خطا در اجرای دستور: ${err.message}`).catch(() => {});
    }
}

async function handleHelp(client, chatId) {
    const helpText = `👋 *ربات آپلودر سرور بله*

پوشه دانلودهای سرور خود را با بله همگام نگه دارید. از این دستورات برای بررسی وضعیت سرور و آپلود مستقیم فایل‌ها به این چت استفاده کنید.

*دستورات در دسترس:*
• /files - لیست فایل‌ها در پوشه دانلود
• /files [subdir] - لیست فایل‌ها در یک پوشه فرعی
• /upload [index/filename] - آپلود یک فایل به این چت
• /status - نمایش پردازنده، رم، فضای دیسک سرور و مدت زمان روشن بودن
• /chatid - نمایش شناسه (Chat ID) این چت
• /help - نمایش این راهنما

_نکته: ابتدا "/files" را تایپ کنید تا لیست فایل‌ها را ببینید، سپس از "/upload 1" برای ارسال اولین فایل استفاده کنید!_`;

    await client.sendMessage(chatId, helpText, { parse_mode: "Markdown" });
}

async function handleStatus(client, chatId) {
    // Let the user know we are calculating
    const statusMsg = await client.sendMessage(chatId, "📊 در حال جمع‌آوری اطلاعات سرور، لطفاً منتظر بمانید...");

    try {
        const serverUptime = os.uptime();
        const botUptime = (Date.now() - startTime) / 1000;

        // CPU details
        const cpuSpeed = await si.cpuCurrentSpeed();
        const cpuLoad = await si.currentLoad();

        // Memory details
        const mem = await si.mem();

        // Disk details
        const disk = await si.fsSize();
        const downloadsDisk = disk.find((d) => config.downloadsDir.startsWith(d.mount)) || disk[0];

        const message = `📊 *گزارش وضعیت سرور*

🤖 *مدت زمان فعالیت ربات:* ${formatUptime(botUptime)}
🖥️ *مدت زمان فعالیت سرور:* ${formatUptime(serverUptime)}
🔥 *بار پردازنده (CPU):* ${cpuLoad.currentLoad.toFixed(1)}% (${cpuSpeed.avg || "نامشخص"} گیگاهرتز)
🧠 *حافظه رم (RAM):*
  • مصرف شده: ${formatBytes(mem.active)} / ${formatBytes(mem.total)} (${((mem.active / mem.total) * 100).toFixed(1)}%)
  • آزاد: ${formatBytes(mem.available)}
💾 *دیسک دانلودها (${downloadsDisk ? downloadsDisk.mount : "نامشخص"}):*
  • مصرف شده: ${downloadsDisk ? formatBytes(downloadsDisk.used) : "نامشخص"} / ${downloadsDisk ? formatBytes(downloadsDisk.size) : "نامشخص"} (${downloadsDisk ? downloadsDisk.use.toFixed(1) : 0}%)
  • آزاد: ${downloadsDisk ? formatBytes(downloadsDisk.available) : "نامشخص"}

📍 *پوشه دانلودها:*
\`${config.downloadsDir}\``;

        // Send final report
        await client.request("sendMessage", {
            chat_id: String(chatId),
            text: message,
            parse_mode: "Markdown",
            reply_to_message_id: statusMsg.message_id,
        });
    } catch (err) {
        logger.error("Failed to compile status report:", err.message);
        await client.request("sendMessage", {
            chat_id: String(chatId),
            text: `❌ خطا در دریافت اطلاعات وضعیت سرور: ${err.message}`,
            reply_to_message_id: statusMsg.message_id,
        });
    }
}

async function handleFiles(client, chatId, args) {
    const subDir = args.join(" ").trim();
    const targetDir = subDir ? path.resolve(config.downloadsDir, subDir) : config.downloadsDir;

    // Security check: ensure target directory is within config.downloadsDir
    const relative = path.relative(config.downloadsDir, targetDir);
    const isSafe = !relative.startsWith("..") && !path.isAbsolute(relative);

    if (targetDir !== config.downloadsDir && !isSafe) {
        return client.sendMessage(chatId, "❌ نقض امنیتی: دسترسی به پوشه رد شد.");
    }

    if (!fs.existsSync(targetDir)) {
        return client.sendMessage(chatId, `❌ پوشه وجود ندارد: \`${subDir}\``, { parse_mode: "Markdown" });
    }

    const dirStats = fs.statSync(targetDir);
    if (!dirStats.isDirectory()) {
        return client.sendMessage(chatId, "❌ مسیر مشخص شده یک فایل است، نه یک پوشه. مستقیماً از دستور /upload استفاده کنید.");
    }

    const files = fs.readdirSync(targetDir);
    const items = [];

    for (const filename of files) {
        if (config.ignoredFiles.has(filename)) continue;
        const filePath = path.join(targetDir, filename);
        const stats = fs.statSync(filePath);

        if (stats.isDirectory()) {
            items.push({
                name: filename + "/",
                isDir: true,
                size: 0,
                path: filePath,
            });
        } else {
            items.push({
                name: filename,
                isDir: false,
                size: stats.size,
                path: filePath,
            });
        }
    }

    // Sort: directories first, then files alphabetically
    items.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
    });

    if (items.length === 0) {
        return client.sendMessage(chatId, `📁 پوشه خالی است: \`${path.basename(targetDir)}\``, {
            parse_mode: "Markdown",
        });
    }

    // Save the listed file paths to the cache for /upload command referencing
    const cacheList = items.filter((item) => !item.isDir).map((item) => item.path);
    lastFileListCache.set(chatId, cacheList);

    let response = `📁 *محتویات ${subDir ? `downloads/${subDir}` : "دانلودها"}:*\n\n`;
    let fileIndex = 1;

    for (const item of items) {
        if (item.isDir) {
            response += `📁 \`${item.name}\` (پوشه)\n`;
        } else {
            response += `*${fileIndex}.* 📄 \`${item.name}\` (${formatBytes(item.size)})\n`;
            fileIndex++;
        }
    }

    response += `\n*برای آپلود فایل، دستور زیر را ارسال کنید:*\n`;
    response += `\`/upload [index]\` (به عنوان مثال \`/upload 1\`)\n`;
    response += `یا \`/upload [filename]\` (به عنوان مثال \`/upload ${items.find((i) => !i.isDir)?.name || "file.mp4"}\`)`;

    await client.sendMessage(chatId, response, { parse_mode: "Markdown" });
}

async function handleUpload(client, chatId, args) {
    if (args.length === 0) {
        return client.sendMessage(chatId, "❌ نحوه استفاده: `/upload [index]` یا `/upload [filename]`", {
            parse_mode: "Markdown",
        });
    }

    const query = args.join(" ").trim();
    let targetFilePath = null;

    // 1. Check if the query is a number/index referencing the cache list
    const index = parseInt(query, 10);
    if (!isNaN(index)) {
        const cachedFiles = lastFileListCache.get(chatId);
        if (cachedFiles && index >= 1 && index <= cachedFiles.length) {
            targetFilePath = cachedFiles[index - 1];
        } else {
            return client.sendMessage(
                chatId,
                `❌ شماره فایل نامعتبر است: ${index}. لطفاً ابتدا دستور /files را اجرا کنید تا شماره‌گذاری فایل‌ها به‌روزرسانی شود.`,
            );
        }
    } else {
        // 2. Treat query as a filename inside downloads directory
        const resolvedPath = path.resolve(config.downloadsDir, query);

        // Security check: ensure path stays within config.downloadsDir
        const relative = path.relative(config.downloadsDir, resolvedPath);
        const isSafe = !relative.startsWith("..") && !path.isAbsolute(relative);

        if (!isSafe) {
            return client.sendMessage(chatId, "❌ نقض امنیتی: دسترسی به پوشه بالاتر مجاز نیست.");
        }

        if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
            targetFilePath = resolvedPath;
        } else {
            return client.sendMessage(
                chatId,
                `❌ فایل پیدا نشد: \`${query}\` در پوشه دانلودها. دستور /files را امتحان کنید تا فایل‌های موجود را ببینید.`,
                { parse_mode: "Markdown" },
            );
        }
    }

    if (!targetFilePath) {
        return client.sendMessage(chatId, "❌ انتخاب فایل با خطا مواجه شد. لطفاً فایل‌ها را با دستور /files لیست کرده و دوباره تلاش کنید.");
    }

    const filename = path.basename(targetFilePath);
    const statusMsg = await client.sendMessage(chatId, `📤 در حال آپلود \`${filename}\` از سرور به بله...`, {
        parse_mode: "Markdown",
    });

    logger.info(`Daemon uploading file for chat ${chatId}: ${targetFilePath}`);

    try {
        const startTime = Date.now();
        await client.sendFile(chatId, targetFilePath, `آپلود شده: ${filename}`);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        logger.success(`Daemon successfully uploaded ${filename} in ${elapsed}s`);
        await client.request("sendMessage", {
            chat_id: String(chatId),
            text: `✅ *آپلود با موفقیت انجام شد!* فایل \`${filename}\` در ${elapsed} ثانیه ارسال شد.`,
            parse_mode: "Markdown",
            reply_to_message_id: statusMsg.message_id,
        });
    } catch (err) {
        logger.error(`Daemon upload failed for ${filename}: ${err.message}`);
        await client.request("sendMessage", {
            chat_id: String(chatId),
            text: `❌ *آپلود ناموفق بود:* ${err.message}`,
            parse_mode: "Markdown",
            reply_to_message_id: statusMsg.message_id,
        });
    }
}

// Support running directly from command line
const nodePath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
const resolvedCurrentPath = path.resolve(currentPath);

if (
    nodePath &&
    (nodePath === resolvedCurrentPath || fs.realpathSync(nodePath) === fs.realpathSync(resolvedCurrentPath))
) {
    logger.info("Starting bot daemon directly via CLI...");
    startBot().catch((err) => {
        logger.error("Unhandled error starting bot daemon:", err.message);
    });
}
