import fs from 'node:fs';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import config from './config.js';
import { zipFile, splitFile, cleanupFiles } from './file-splitter.js';

// Common video extensions for Bale's sendVideo API
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.avi', '.mkv']);

// Map file extensions to MIME types
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.m4v': return 'video/x-m4v';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.avi': return 'video/x-msvideo';
    case '.mkv': return 'video/x-matroska';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.pdf': return 'application/pdf';
    case '.zip': return 'application/zip';
    case '.rar': return 'application/x-rar-compressed';
    case '.txt': return 'text/plain';
    case '.json': return 'application/json';
    default: return 'application/octet-stream';
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
      throw new Error('Bale Bot Token is required.');
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
      method: 'POST',
    };

    if (body) {
      if (isMultipart) {
        options.body = body; // Body is FormData, browser/Node will set boundaries automatically
      } else {
        options.headers = {
          'Content-Type': 'application/json',
        };
        options.body = JSON.stringify(body);
      }
    }

    try {
      const response = await fetch(url, options);
      const contentType = response.headers.get('content-type') || '';

      if (!response.ok) {
        let errorMsg = `HTTP Error ${response.status}: ${response.statusText}`;
        if (contentType.includes('application/json')) {
          const errData = await response.json();
          errorMsg = errData.description || errorMsg;
        } else {
          const text = await response.text();
          const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/i);
          const bodySnippet = titleMatch ? titleMatch[1] : (text.slice(0, 100).replace(/\s+/g, ' ').trim());
          errorMsg = `Server HTML Response: ${bodySnippet || `Status ${response.status}`}`;
        }
        throw new Error(errorMsg);
      }

      if (!contentType.includes('application/json')) {
        const text = await response.text();
        throw new Error(`Expected JSON response but received: ${text.slice(0, 150)}...`);
      }

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.description || 'Unknown API Error');
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
    return this.request('getMe');
  }

  /**
   * Fetch updates from Bale servers (long polling)
   */
  async getUpdates(offset = 0, limit = 100, timeout = 30) {
    return this.request('getUpdates', { offset, limit, timeout });
  }

  /**
   * Send a text message to a chat
   */
  async sendMessage(chatId, text, options = {}) {
    return this.request('sendMessage', {
      chat_id: String(chatId),
      text,
      ...options,
    });
  }

  /**
   * Upload and send a video file from local path
   */
  async sendVideo(chatId, filePath, caption = '', options = {}, disableSplit = false) {
    const stats = fs.statSync(filePath);
    if (!disableSplit && stats.size > config.uploadMaxSize) {
      return this.uploadLargeFile(chatId, filePath, caption);
    }

    const fileName = path.basename(filePath);
    const mimeType = getMimeType(filePath);
    const safeFileName = sanitizeHeaderFilename(fileName);
    
    // Open the file as a Blob to stream it directly from disk (Node 20+ memory efficiency)
    const fileBlob = await openAsBlob(filePath, { type: mimeType });
    
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('video', fileBlob, safeFileName);
    if (caption) {
      formData.append('caption', caption);
    }

    // Add extra optional parameters (like reply_to_message_id)
    for (const [key, val] of Object.entries(options)) {
      formData.append(key, String(val));
    }

    return this.request('sendVideo', formData, true);
  }

  /**
   * Upload and send a general document file from local path
   */
  async sendDocument(chatId, filePath, caption = '', options = {}, disableSplit = false) {
    const stats = fs.statSync(filePath);
    if (!disableSplit && stats.size > config.uploadMaxSize) {
      return this.uploadLargeFile(chatId, filePath, caption);
    }

    const fileName = path.basename(filePath);
    const mimeType = getMimeType(filePath);
    const safeFileName = sanitizeHeaderFilename(fileName);
    
    // Open the file as a Blob to stream it directly from disk
    const fileBlob = await openAsBlob(filePath, { type: mimeType });
    
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('document', fileBlob, safeFileName);
    if (caption) {
      formData.append('caption', caption);
    }

    // Add extra optional parameters
    for (const [key, val] of Object.entries(options)) {
      formData.append(key, String(val));
    }

    return this.request('sendDocument', formData, true);
  }

  /**
   * Helper to automatically determine whether to use sendVideo or sendDocument
   */
  async sendFile(chatId, filePath, caption = '', options = {}) {
    const stats = fs.statSync(filePath);
    if (stats.size > config.uploadMaxSize) {
      return this.uploadLargeFile(chatId, filePath, caption);
    }

    const ext = path.extname(filePath).toLowerCase();
    if (VIDEO_EXTENSIONS.has(ext)) {
      return this.sendVideo(chatId, filePath, caption, options, true);
    } else {
      return this.sendDocument(chatId, filePath, caption, options, true);
    }
  }

  /**
   * Zip and split large files, uploading the chunks sequentially with merging instructions
   */
  async uploadLargeFile(chatId, filePath, caption = '') {
    const fileStats = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    let fileToSplit = filePath;
    let isTempZipCreated = false;
    let zipPath = '';

    // Step 1: Zip the file if it's not already a compressed archive
    if (ext === '.zip' || ext === '.rar' || ext === '.gz' || ext === '.7z') {
      fileToSplit = filePath;
    } else {
      const tempZipName = `${path.basename(filePath, ext)}_${Date.now()}.zip`;
      zipPath = path.join(config.tempDir, tempZipName);
      
      console.log(`[BALE CLIENT] Compressing large file: ${fileName} -> ${tempZipName}`);
      try {
        await zipFile(filePath, zipPath);
        fileToSplit = zipPath;
        isTempZipCreated = true;
      } catch (err) {
        console.error(`[BALE CLIENT] Compression failed, falling back to raw binary split:`, err.message);
        fileToSplit = filePath; // Fallback to raw binary split if zipping fails
      }
    }

    const sizeToSplit = fs.statSync(fileToSplit).size;
    const readableChunkSize = (config.uploadMaxSize / (1024 * 1024)).toFixed(1);
    console.log(`[BALE CLIENT] Splitting file into chunks of size ${readableChunkSize}MB: ${path.basename(fileToSplit)}`);
    
    let chunks = [];
    try {
      // Step 2: Split the file in config.tempDir
      chunks = await splitFile(fileToSplit, config.uploadMaxSize, config.tempDir);
    } catch (err) {
      if (isTempZipCreated) cleanupFiles([zipPath]);
      throw new Error(`Failed to split file: ${err.message}`);
    }

    const totalChunks = chunks.length;
    console.log(`[BALE CLIENT] Split complete: ${totalChunks} parts. Uploading sequentially...`);

    const uploadedMessageIds = [];
    const baseNameOfFile = path.basename(fileToSplit);

    try {
      // Step 3: Upload chunks sequentially
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = chunks[i];
        const chunkName = path.basename(chunkPath);
        
        console.log(`[BALE CLIENT] Uploading chunk ${i + 1}/${totalChunks}: ${chunkName}`);
        
        // Pass disableSplit = true to avoid infinite recursion
        const result = await this.sendDocument(chatId, chunkPath, `Part ${i + 1}/${totalChunks}: ${chunkName}`, {}, true);
        uploadedMessageIds.push(result.message_id);
        
        // Respect rate limits between sequential API calls
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      // Step 4: Send extraction command instructions to the user
      const displayFileName = isTempZipCreated ? path.basename(filePath) + '.zip' : fileName;
      const extractionInstructions = `📦 *Large File Split-Upload Completed*

The file *${fileName}* exceeded the upload limit and was sent in *${totalChunks} parts*.

*How to merge and open:*
1. Download all ${totalChunks} parts into the same folder on your computer.
2. Open terminal/cmd in that folder and run the merge command:
   • *Windows (Command Prompt):*
     \`copy /b "${baseNameOfFile}.001" ${chunks.slice(1).map((_, idx) => `+ "${baseNameOfFile}.${String(idx + 2).padStart(3, '0')}"`).join(' ')} "${displayFileName}"\`
   • *Linux / macOS (Terminal):*
     \`cat "${baseNameOfFile}".* > "${displayFileName}"\`
3. ${isTempZipCreated ? `Decompress the merged archive *${displayFileName}* to access your original file.` : `Your file *${displayFileName}* is ready to use immediately after merging.`}`;

      console.log(`[BALE CLIENT] Sending merge instructions message...`);
      const finalMsg = await this.sendMessage(chatId, extractionInstructions, { parse_mode: 'Markdown' });
      uploadedMessageIds.push(finalMsg.message_id);

      return { message_id: uploadedMessageIds[0], all_message_ids: uploadedMessageIds };
    } finally {
      // Step 5: Clean up all temp files
      const filesToCleanup = [...chunks];
      if (isTempZipCreated) {
        filesToCleanup.push(zipPath);
      }
      cleanupFiles(filesToCleanup);
      console.log(`[BALE CLIENT] Temporary zip and chunk files successfully deleted from server.`);
    }
  }

  /**
   * Answer a callback query from an inline button press
   */
  async answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
    return this.request('answerCallbackQuery', {
      callback_query_id: String(callbackQueryId),
      text,
      show_alert: showAlert
    });
  }

  /**
   * Edit a message's text and markup inline
   */
  async editMessageText(chatId, messageId, text, options = {}) {
    return this.request('editMessageText', {
      chat_id: String(chatId),
      message_id: Number(messageId),
      text,
      ...options
    });
  }
}

export default BaleClient;
