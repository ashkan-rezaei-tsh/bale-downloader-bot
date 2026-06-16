import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const token = process.env.BALE_BOT_TOKEN || "";
const isPlaceholderToken = token === "your_bale_bot_token_here" || token.trim() === "";

if (isPlaceholderToken) {
    console.warn(
        "\x1b[33m%s\x1b[0m",
        "⚠️ WARNING: BALE_BOT_TOKEN is not configured or is using the placeholder. Please set a valid Bale bot token in the .env file.",
    );
}

// Resolve and verify downloads directory
let downloadsDir = process.env.DOWNLOADS_DIR || path.join(__dirname, "downloads");
downloadsDir = path.resolve(downloadsDir);

if (!fs.existsSync(downloadsDir)) {
    try {
        fs.mkdirSync(downloadsDir, { recursive: true });
        console.log(`Created downloads directory at: ${downloadsDir}`);
    } catch (err) {
        console.error(`Failed to create downloads directory at ${downloadsDir}:`, err.message);
    }
}

// Resolve and verify temp directory
let tempDir = path.join(__dirname, "temp");
tempDir = path.resolve(tempDir);

if (!fs.existsSync(tempDir)) {
    try {
        fs.mkdirSync(tempDir, { recursive: true });
    } catch (err) {
        console.error(`Failed to create temp directory at ${tempDir}:`, err.message);
    }
} else {
    // Clear temp files on startup to prevent storage leaks from previous crashed/interrupted runs
    try {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            if (fs.statSync(filePath).isFile()) {
                fs.unlinkSync(filePath);
            }
        }
        console.log(`Cleared temporary uploads folder on startup: ${tempDir}`);
    } catch (err) {
        console.error(`Failed to empty temp directory on startup:`, err.message);
    }
}

// Parse allowed chat IDs
const allowedChatIdsStr = process.env.ALLOWED_CHAT_IDS || "";
const allowedChatIds = allowedChatIdsStr
    ? allowedChatIdsStr
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id !== "")
    : [];

// Parse ignored files
const ignoredFilesStr = process.env.IGNORE_FILES || "cookies.txt,yt-dlp.conf,yt-dlp_linux";
const ignoredFiles = new Set(
    ignoredFilesStr
        .split(",")
        .map((f) => f.trim())
        .filter((f) => f !== ""),
);

export const config = {
    token,
    isPlaceholderToken,
    downloadsDir,
    tempDir,
    uploadMaxSize: parseInt(process.env.UPLOAD_MAX_SIZE_MB || "19", 10) * 1024 * 1024,
    defaultChatId: process.env.DEFAULT_CHAT_ID || "",
    allowedChatIds,
    port: parseInt(process.env.PORT || "3000", 10),
    dashboardPassword: process.env.DASHBOARD_PASSWORD || "admin",
    ignoredFiles,
    downloadLinkExpiry: process.env.DOWNLOAD_LINK_EXPIRY || "1h",
    isChatAllowed(chatId) {
        if (this.allowedChatIds.length === 0) return true; // Whitelist empty = allow all
        return this.allowedChatIds.includes(String(chatId));
    },
};

export default config;
