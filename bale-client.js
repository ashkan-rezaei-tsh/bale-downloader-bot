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

// Sanitize filenames to ensure they contain only safe ASCII characters in HTTP headers
function sanitizeHeaderFilename(filename) {
  return filename
    .replace(/[^\x20-\x7E]/g, '_') // Replace non-ASCII (including full-width colon '：') with underscore
    .replace(/[;"]/g, '_');         // Replace characters that can break header parsing
}

export class BaleClient {
    constructor(token) {
        if (!token) {
            throw new Error("Bale Bot Token is required.");
        }
        this.token = token;
        this.baseUrl = `https://tapi.bale.ai/bot${token}`;
    }

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
            const contentType = response.headers.get("content-type") || "";

            if (!response.ok) {
                let errorMsg = `HTTP Error ${response.status}: ${response.statusText}`;
                if (contentType.includes("application/json")) {
                    const errData = await response.json();
                    errorMsg = errData.description || errorMsg;
                } else {
                    const text = await response.text();
                    // Try to extract title or first 100 characters of body for context
                    const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/i);
                    const bodySnippet = titleMatch ? titleMatch[1] : (text.slice(0, 100).replace(/\s+/g, ' ').trim());
                    errorMsg = `Server HTML Response: ${bodySnippet || `Status ${response.status}`}`;
                }
                throw new Error(errorMsg);
            }

            if (!contentType.includes("application/json")) {
                const text = await response.text();
                throw new Error(`Expected JSON response but received: ${text.slice(0, 150)}...`);
            }

            const data = await response.json();
            if (!data.ok) {
                throw new Error(data.description || "Unknown API Error");
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
        const safeFileName = sanitizeHeaderFilename(fileName);

        // Open the file as a Blob to stream it directly from disk (Node 20+ memory efficiency)
        const fileBlob = await openAsBlob(filePath, { type: mimeType });

        const formData = new FormData();
        formData.append("chat_id", String(chatId));
        formData.append("video", fileBlob, safeFileName);
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
        const safeFileName = sanitizeHeaderFilename(fileName);

        // Open the file as a Blob to stream it directly from disk
        const fileBlob = await openAsBlob(filePath, { type: mimeType });

        const formData = new FormData();
        formData.append("chat_id", String(chatId));
        formData.append("document", fileBlob, safeFileName);
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
