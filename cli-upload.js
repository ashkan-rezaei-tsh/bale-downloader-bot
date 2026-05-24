import fs from "node:fs";
import path from "node:path";
import config from "./config.js";
import BaleClient from "./bale-client.js";

function printUsage() {
    console.log(`
\x1b[35mBale Bot Server Uploader CLI\x1b[0m
====================================
Usage:
  node cli-upload.js --file <path> [--chat <chat_id>] [--caption <caption>] [--type <video|document|auto>]

Options:
  --file, -f       Path to the file to upload (required).
  --chat, -c       Bale Chat ID or Channel Username (falls back to DEFAULT_CHAT_ID in .env).
  --caption, -m    Optional text caption for the upload.
  --type, -t       Upload method: 'video', 'document', or 'auto' (default: 'auto').

Examples:
  node cli-upload.js --file ./videos/clip.mp4 --caption "Check out this download!"
  node cli-upload.js -f /tmp/backup.zip -c -10012345678 -t document
`);
}

async function run() {
    const args = process.argv.slice(2);
    const params = {};

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--file" || arg === "-f") {
            params.file = args[++i];
        } else if (arg === "--chat" || arg === "-c") {
            params.chat = args[++i];
        } else if (arg === "--caption" || arg === "-m") {
            params.caption = args[++i];
        } else if (arg === "--type" || arg === "-t") {
            params.type = args[++i];
        } else if (arg === "--help" || arg === "-h") {
            printUsage();
            process.exit(0);
        }
    }

    // Validate file
    if (!params.file) {
        console.error("\x1b[31mError: Missing required argument --file (-f)\x1b[0m");
        printUsage();
        process.exit(1);
    }

    const filePath = path.resolve(params.file);
    if (!fs.existsSync(filePath)) {
        console.error(`\x1b[31mError: File not found at: ${filePath}\x1b[0m`);
        process.exit(1);
    }

    const fileStats = fs.statSync(filePath);
    if (fileStats.isDirectory()) {
        console.error(`\x1b[31mError: Path is a directory, not a file: ${filePath}\x1b[0m`);
        process.exit(1);
    }

    // Validate Token
    if (config.isPlaceholderToken) {
        console.error("\x1b[31mError: Bale Bot Token is not configured. Please edit the .env file.\x1b[0m");
        process.exit(1);
    }

    // Target chat
    const targetChatId = params.chat || config.defaultChatId;
    if (!targetChatId) {
        console.error(
            "\x1b[31mError: No target chat specified. Pass --chat or configure DEFAULT_CHAT_ID in .env\x1b[0m",
        );
        process.exit(1);
    }

    const type = params.type || "auto";
    const caption = params.caption || "";

    const client = new BaleClient(config.token);

    console.log(`\x1b[36mStarting upload...\x1b[0m`);
    console.log(`File:    ${path.basename(filePath)} (${(fileStats.size / (1024 * 1024)).toFixed(2)} MB)`);
    console.log(`Chat ID: ${targetChatId}`);
    console.log(`Type:    ${type}`);

    try {
        let result;
        if (type === "video") {
            result = await client.sendVideo(targetChatId, filePath, caption);
        } else if (type === "document") {
            result = await client.sendDocument(targetChatId, filePath, caption);
        } else {
            result = await client.sendFile(targetChatId, filePath, caption);
        }
        console.log(`\x1b[32mSuccess! File sent successfully.\x1b[0m`);
        console.log(`Message ID: ${result.message_id}`);
        process.exit(0);
    } catch (error) {
        console.error(`\x1b[31mUpload failed:\x1b[0m`, error.message);
        process.exit(1);
    }
}

run();
