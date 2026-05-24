import { openAsBlob } from "node:fs";
import path from "node:path";

// Common video extensions for Bale's sendVideo API
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".avi", ".mkv"]);

// Map file extensions to MIME types
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case ".mp4":
            return "video/mp4";
        case ".m4v":
            return "video/x-m4v";
        case ".mov":
            return "video/quicktime";
        case ".webm":
            return "video/webm";
        case ".avi":
            return "video/x-msvideo";
        case ".mkv":
            return "video/x-matroska";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".png":
            return "image/png";
        case ".gif":
            return "image/gif";
        case ".pdf":
            return "application/pdf";
        case ".zip":
            return "application/zip";
        case ".rar":
            return "application/x-rar-compressed";
        case ".txt":
            return "text/plain";
        case ".json":
            return "application/json";
        default:
            return "application/octet-stream";
    }
}

export class BaleClient {
    constructor(token) {
        if (!token) {
            throw new Error("Bale Bot Token is required.");
        }
        this.token = token;
        this.baseUrl = `https://tapi.bale.ai/bot${token}`;
    }

    /**
     * Internal request helper
     */
    async request(method, body = null, isMultipart = false) {
        const url = `${this.baseUrl}/${method}`;
        const options = {
            method: "POST",
        };

        if (body) {
            if (isMultipart) {
                options.body = body; // Body is FormData, browser/Node will set boundaries automatically
            } else {
                options.headers = {
                    "Content-Type": "application/json",
                };
                options.body = JSON.stringify(body);
            }
        }

        try {
            const response = await fetch(url, options);
            const data = await response.json();
            if (!response.ok || !data.ok) {
                const errorMsg = data.description || response.statusText || "Unknown API Error";
                throw new Error(`Bale API Error (${response.status}): ${errorMsg}`);
            }
            return data.result;
        } catch (error) {
            console.error(`Error in Bale API call [${method}]:`, error.message);
            throw error;
        }
    }

    /**
     * Get bot information
     */
    async getMe() {
        return this.request("getMe");
    }

    /**
     * Fetch updates from Bale servers (long polling)
     */
    async getUpdates(offset = 0, limit = 100, timeout = 30) {
        return this.request("getUpdates", { offset, limit, timeout });
    }

    /**
     * Send a text message to a chat
     */
    async sendMessage(chatId, text, options = {}) {
        return this.request("sendMessage", {
            chat_id: String(chatId),
            text,
            ...options,
        });
    }

    /**
     * Upload and send a video file from local path
     */
    async sendVideo(chatId, filePath, caption = "", options = {}) {
        const fileName = path.basename(filePath);
        const mimeType = getMimeType(filePath);

        // Open the file as a Blob to stream it directly from disk (Node 20+ memory efficiency)
        const fileBlob = await openAsBlob(filePath, { type: mimeType });

        const formData = new FormData();
        formData.append("chat_id", String(chatId));
        formData.append("video", fileBlob, fileName);
        if (caption) {
            formData.append("caption", caption);
        }

        // Add extra optional parameters (like reply_to_message_id)
        for (const [key, val] of Object.entries(options)) {
            formData.append(key, String(val));
        }

        return this.request("sendVideo", formData, true);
    }

    /**
     * Upload and send a general document file from local path
     */
    async sendDocument(chatId, filePath, caption = "", options = {}) {
        const fileName = path.basename(filePath);
        const mimeType = getMimeType(filePath);

        // Open the file as a Blob to stream it directly from disk
        const fileBlob = await openAsBlob(filePath, { type: mimeType });

        const formData = new FormData();
        formData.append("chat_id", String(chatId));
        formData.append("document", fileBlob, fileName);
        if (caption) {
            formData.append("caption", caption);
        }

        // Add extra optional parameters
        for (const [key, val] of Object.entries(options)) {
            formData.append(key, String(val));
        }

        return this.request("sendDocument", formData, true);
    }

    /**
     * Helper to automatically determine whether to use sendVideo or sendDocument
     */
    async sendFile(chatId, filePath, caption = "", options = {}) {
        const ext = path.extname(filePath).toLowerCase();
        if (VIDEO_EXTENSIONS.has(ext)) {
            return this.sendVideo(chatId, filePath, caption, options);
        } else {
            return this.sendDocument(chatId, filePath, caption, options);
        }
    }
}

export default BaleClient;
