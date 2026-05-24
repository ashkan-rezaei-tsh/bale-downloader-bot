import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import si from "systeminformation";
import config from "./config.js";
import BaleClient from "./bale-client.js";
import logger from "./logger.js";
import { searchYouTube, startDownload, getActiveDownloads } from "./youtube-service.js";

// Cache for mapping chat IDs to their last listed file paths (makes it easy to do /upload 1)
const lastFileListCache = new Map();

// Cache for active YouTube search results per chat ID to handle bot pagination
const ytSearchCache = new Map();

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
                } else if (update.callback_query) {
                    // Handle callback queries from inline buttons
                    handleCallbackQuery(client, update.callback_query).catch((err) => {
                        logger.error(`Error handling callback query: ${err.message}`, err.stack);
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

async function handleCallbackQuery(client, callbackQuery) {
    const queryId = callbackQuery.id;
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    // Check authorization
    if (!config.isChatAllowed(chatId)) {
        logger.warn(`Unauthorized callback query from Chat ID: ${chatId}`);
        return client.answerCallbackQuery(queryId, "❌ دسترسی غیرمجاز", true).catch(() => {});
    }

    try {
        if (data.startsWith("dir:")) {
            const targetSubDir = data.slice(4);
            // Answer the callback query to clear the loading spinner
            await client.answerCallbackQuery(queryId, "📁 در حال بروزرسانی لیست...").catch(() => {});
            // Reload files in-place by editing the message
            await handleFiles(client, chatId, targetSubDir ? [targetSubDir] : [], messageId);
        } else if (data.startsWith("up:")) {
            const fileIndexStr = data.slice(3);
            await client.answerCallbackQuery(queryId, "📤 در حال آغاز آپلود...").catch(() => {});
            // Execute upload
            await handleUpload(client, chatId, [fileIndexStr]);
        } else if (data.startsWith("ytpage:")) {
            const nextPage = parseInt(data.slice(7), 10);
            await client.answerCallbackQuery(queryId, "🔄 در حال بارگذاری صفحه...").catch(() => {});
            await sendSearchPage(client, chatId, nextPage, messageId);
        } else if (data.startsWith("ytsel:")) {
            const absIndex = parseInt(data.slice(6), 10);
            await client.answerCallbackQuery(queryId, "ℹ️ در حال دریافت جزئیات ویدیو...").catch(() => {});
            await sendVideoDetails(client, chatId, absIndex, messageId);
        } else if (data === "ytback") {
            await client.answerCallbackQuery(queryId, "🔙 بازگشت به نتایج...").catch(() => {});
            const cache = ytSearchCache.get(chatId);
            const lastPage = cache ? cache.page : 0;
            await sendSearchPage(client, chatId, lastPage, messageId);
        } else if (data.startsWith("ytdl:")) {
            const parts = data.split(":");
            const type = parts[1]; // 'video' or 'audio'
            const absIndex = parseInt(parts[2], 10);
            await client.answerCallbackQuery(queryId, "📥 در حال ثبت درخواست دانلود...").catch(() => {});
            await triggerYoutubeDownload(client, chatId, absIndex, type, messageId);
        } else if (data.startsWith("up_dl:")) {
            const jobId = data.slice(6);
            await client.answerCallbackQuery(queryId, "📤 در حال آغاز آپلود فایل...").catch(() => {});
            await handleJobUpload(client, chatId, jobId);
        }
    } catch (err) {
        logger.error(`Error processing callback query: ${err.message}`);
        await client.sendMessage(chatId, `❌ خطا در پردازش کلید: ${err.message}`).catch(() => {});
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
            case "/search":
                await handleSearch(client, chatId, args);
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

پوشه دانلودهای سرور خود را با بله همگام نگه دارید. از این دستورات برای بررسی وضعیت سرور، جستجو و دانلود از یوتیوب و آپلود فایل‌ها استفاده کنید.

*دستورات در دسترس:*
• /files - لیست فایل‌ها در پوشه دانلود
• /files [subdir] - لیست فایل‌ها در یک پوشه فرعی
• /upload [index/filename] - آپلود یک فایل به این چت
• /search [query] - جستجو و دانلود ویدیوها از یوتیوب
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

async function handleFiles(client, chatId, args, editMessageId = null) {
    const subDir = args.join(" ").trim();
    const targetDir = subDir ? path.resolve(config.downloadsDir, subDir) : config.downloadsDir;

    // Security check: ensure target directory is within config.downloadsDir
    const relative = path.relative(config.downloadsDir, targetDir);
    const isSafe = targetDir === config.downloadsDir || (!relative.startsWith("..") && !path.isAbsolute(relative));

    if (!isSafe) {
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
        const emptyMsg = `📁 پوشه خالی است: \`${path.basename(targetDir)}\``;
        const emptyKeyboard = [];
        if (subDir) {
            const parentDir = path.dirname(subDir);
            const parentData = parentDir === "." || parentDir === "/" || parentDir === "" ? "dir:" : `dir:${parentDir.replace(/\\/g, "/")}`;
            emptyKeyboard.push([{ text: "🔙 بازگشت به پوشه قبل", callback_data: parentData }]);
        }
        
        if (editMessageId) {
            try {
                await client.editMessageText(chatId, editMessageId, emptyMsg, {
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: emptyKeyboard }
                });
                return;
            } catch (err) {
                // Fallback
            }
        }
        return client.sendMessage(chatId, emptyMsg, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: emptyKeyboard }
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
    response += `یا از دکمه‌های زیر برای انتخاب سریع استفاده کنید:`;

    // Construct Inline Keyboard
    const keyboard = [];
    let row = [];

    // Folder buttons: 2 per row
    const dirItems = items.filter((i) => i.isDir);
    for (let i = 0; i < dirItems.length; i++) {
        const item = dirItems[i];
        const relPath = path.relative(config.downloadsDir, item.path).replace(/\\/g, "/");
        row.push({
            text: `📁 ${item.name}`,
            callback_data: `dir:${relPath}`
        });
        if (row.length === 2 || i === dirItems.length - 1) {
            keyboard.push(row);
            row = [];
        }
    }

    // File buttons: 1 per row (since filenames can be long)
    const fileItems = items.filter((i) => !i.isDir);
    let inlineFileIndex = 1;
    for (let i = 0; i < fileItems.length; i++) {
        const item = fileItems[i];
        const truncatedName = item.name.length > 25 ? item.name.slice(0, 22) + "..." : item.name;
        keyboard.push([
            {
                text: `📤 ${inlineFileIndex}. ${truncatedName} (${formatBytes(item.size)})`,
                callback_data: `up:${inlineFileIndex}`
            }
        ]);
        inlineFileIndex++;
    }

    // Back button if in a subdirectory
    if (subDir) {
        const parentDir = path.dirname(subDir);
        const parentData = parentDir === "." || parentDir === "/" || parentDir === "" ? "dir:" : `dir:${parentDir.replace(/\\/g, "/")}`;
        keyboard.push([
            {
                text: "🔙 بازگشت به پوشه قبل",
                callback_data: parentData
            }
        ]);
    }

    // Send or Edit Message
    if (editMessageId) {
        try {
            await client.editMessageText(chatId, editMessageId, response, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
            return;
        } catch (err) {
            logger.warn(`Failed to edit message in-place, sending a new message: ${err.message}`);
        }
    }

    await client.sendMessage(chatId, response, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
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

// YouTube Search handler command
async function handleSearch(client, chatId, args) {
    if (args.length === 0) {
        return client.sendMessage(chatId, "❌ نحوه استفاده: `/search [عبارت جستجو]`", {
            parse_mode: "Markdown",
        });
    }

    const query = args.join(" ").trim();
    const searchMsg = await client.sendMessage(chatId, "🔍 در حال جستجو در یوتیوب، لطفاً منتظر بمانید...");

    try {
        const results = await searchYouTube(query);
        if (!results.videos || results.videos.length === 0) {
            return client.editMessageText(chatId, searchMsg.message_id, `❌ هیچ ویدیویی برای عبارت "${query}" یافت نشد.`);
        }

        // Save active query and search results in cache
        ytSearchCache.set(chatId, {
            query,
            videos: results.videos,
            page: 0
        });

        await sendSearchPage(client, chatId, 0, searchMsg.message_id);
    } catch (err) {
        logger.error(`YouTube search failed: ${err.message}`);
        await client.editMessageText(chatId, searchMsg.message_id, `❌ خطای سیستم در حین جستجو: ${err.message}`);
    }
}

// Send paginated YouTube search results
async function sendSearchPage(client, chatId, page, editMessageId = null) {
    const cache = ytSearchCache.get(chatId);
    if (!cache) {
        return client.sendMessage(chatId, "❌ هیچ جستجوی فعالی یافت نشد. مجدداً دستور `/search` را بفرستید.");
    }

    // Update active page
    cache.page = page;
    ytSearchCache.set(chatId, cache);

    const videos = cache.videos;
    const itemsPerPage = 5;
    const totalPages = Math.ceil(videos.length / itemsPerPage);
    const startIdx = page * itemsPerPage;
    const pageVideos = videos.slice(startIdx, startIdx + itemsPerPage);

    let text = `🔍 *نتایج جستجوی یوتیوب برای:* "${cache.query}"\n`;
    text += `صفحه *${page + 1}* از *${totalPages}*\n\n`;

    const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
    const keyboard = [];
    const selectionRow = [];

    pageVideos.forEach((video, index) => {
        const absoluteIndex = startIdx + index;
        text += `${numberEmojis[index]} *${video.title}*\n`;
        text += `⏱️ زمان: ${video.duration ? video.duration.timestamp : (video.timestamp || "نامشخص")} | 👤 کانال: ${video.author ? video.author.name : "نامشخص"}\n\n`;

        selectionRow.push({
            text: numberEmojis[index],
            callback_data: `ytsel:${absoluteIndex}`
        });
    });

    keyboard.push(selectionRow);

    // Pagination Row
    const paginationRow = [];
    if (page > 0) {
        paginationRow.push({
            text: "◀️ قبلی",
            callback_data: `ytpage:${page - 1}`
        });
    }
    if (page < totalPages - 1) {
        paginationRow.push({
            text: "بعدی ▶️",
            callback_data: `ytpage:${page + 1}`
        });
    }

    if (paginationRow.length > 0) {
        keyboard.push(paginationRow);
    }

    if (editMessageId) {
        try {
            await client.editMessageText(chatId, editMessageId, text, {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: keyboard }
            });
            return;
        } catch (err) {
            // fallback if edit fails
        }
    }

    await client.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

// Send detailed video card inside chat
async function sendVideoDetails(client, chatId, absIndex, editMessageId) {
    const cache = ytSearchCache.get(chatId);
    if (!cache || !cache.videos[absIndex]) {
        return client.sendMessage(chatId, "❌ ویدیوی انتخاب شده در حافظه موقت یافت نشد.");
    }

    const video = cache.videos[absIndex];
    const text = `🎥 *جزئیات ویدیو:*

📌 *عنوان:* \`${video.title}\`
👤 *کانال:* \`${video.author ? video.author.name : "نامشخص"}\`
⏱️ *مدت زمان:* ${video.duration ? video.duration.timestamp : (video.timestamp || "نامشخص")}
👁️ *تعداد بازدید:* ${video.views ? video.views.toLocaleString() : "نامشخص"}
🔗 *لینک:* ${video.url}

📥 *لطفاً فرمت دانلود به سرور را انتخاب کنید:*`;

    const keyboard = [
        [
            { text: "🎥 دانلود ویدیو (MP4)", callback_data: `ytdl:video:${absIndex}` },
            { text: "🎵 دانلود صوتی (MP3)", callback_data: `ytdl:audio:${absIndex}` }
        ],
        [
            { text: "🔙 بازگشت به لیست نتایج", callback_data: "ytback" }
        ]
    ];

    await client.editMessageText(chatId, editMessageId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

// Trigger background download and register callbacks
async function triggerYoutubeDownload(client, chatId, absIndex, type, editMessageId) {
    const cache = ytSearchCache.get(chatId);
    if (!cache || !cache.videos[absIndex]) {
        return client.sendMessage(chatId, "❌ ویدیوی انتخاب شده یافت نشد.");
    }

    const video = cache.videos[absIndex];
    const typeLabel = type === "video" ? "ویدیو (MP4)" : "صدا (MP3)";

    await client.editMessageText(chatId, editMessageId, `📥 دانلود ${typeLabel} به سرور آغاز شد:\n\`${video.title}\`\n\nپس از اتمام دانلود و ذخیره روی سرور، پیامی حاوی دکمه آپلود دریافت خواهید کرد.`, {
        parse_mode: "Markdown"
    });

    try {
        startDownload(video.url, type, (job) => {
            // onComplete callback
            sendDownloadNotification(client, chatId, job).catch(err => {
                logger.error(`Failed to send completed download notification: ${err.message}`);
            });
        }, (job, error) => {
            // onError callback
            sendDownloadErrorNotification(client, chatId, job, error).catch(err => {
                logger.error(`Failed to send failed download notification: ${err.message}`);
            });
        });
    } catch (err) {
        logger.error(`yt-dlp download spawn failed: ${err.message}`);
        await client.sendMessage(chatId, `❌ شروع فرآیند دانلود با خطا مواجه شد: ${err.message}`);
    }
}

// Notify user in chat when background download successfully completes
async function sendDownloadNotification(client, chatId, job) {
    const filename = job.outputFile ? path.basename(job.outputFile) : "file";
    const sizeStr = job.outputFile && fs.existsSync(job.outputFile)
        ? formatBytes(fs.statSync(job.outputFile).size)
        : "--";

    const text = `✅ *دانلود از یوتیوب با موفقیت به پایان رسید!*

📄 *نام فایل:* \`${filename}\`
💾 *حجم فایل:* ${sizeStr}

📥 برای آپلود مستقیم این فایل به چت بله، دکمه زیر را فشار دهید:`;

    const keyboard = [
        [{ text: "📤 آپلود به بله", callback_data: `up_dl:${job.id}` }]
    ];

    await client.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

// Notify user in chat when download fails
async function sendDownloadErrorNotification(client, chatId, job, error) {
    const title = job.title || "ویدیو";
    const text = `❌ *دانلود از یوتیوب ناموفق بود!*

📌 *عنوان ویدیو:* \`${title}\`
⚠️ *خطا:* \`${error || "خطای ناشناخته در حین دانلود"}\``;

    await client.sendMessage(chatId, text, {
        parse_mode: "Markdown"
    });
}

// Handle upload of downloaded files via short session ID references
async function handleJobUpload(client, chatId, jobId) {
    const downloads = getActiveDownloads();
    const job = downloads.find(d => d.id === jobId);

    if (!job || !job.outputFile || !fs.existsSync(job.outputFile)) {
        return client.sendMessage(chatId, "❌ فایل مورد نظر روی سرور یافت نشد. ممکن است فایل حذف شده باشد.");
    }

    const filename = path.basename(job.outputFile);
    const statusMsg = await client.sendMessage(chatId, `📤 در حال آپلود فایل \`${filename}\` از سرور به بله...`, {
        parse_mode: "Markdown",
    });

    try {
        const uploadStartTime = Date.now();
        // Trigger split upload automatically if files exceed the max limit!
        await client.sendFile(chatId, job.outputFile, `آپلود شده: ${filename}`);
        const elapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(1);

        logger.success(`Job upload completed: ${filename} in ${elapsed}s`);
        await client.sendMessage(chatId, `✅ *آپلود فایل با موفقیت انجام شد!* فایل \`${filename}\` در ${elapsed} ثانیه ارسال شد.`, {
            parse_mode: "Markdown",
            reply_to_message_id: statusMsg.message_id
        });
    } catch (err) {
        logger.error(`Job upload failed for ${filename}: ${err.message}`);
        await client.sendMessage(chatId, `❌ *آپلود ناموفق بود:* ${err.message}`, {
            parse_mode: "Markdown",
            reply_to_message_id: statusMsg.message_id
        });
    }
}
