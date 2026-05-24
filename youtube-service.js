import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ytSearch from 'yt-search';
import config from './config.js';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Active downloads cache map
const activeDownloads = new Map();

// Helper to load yt-dlp config
function getYtDlpConfig() {
  const configPath = path.resolve(__dirname, 'ytdlp-config.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      logger.error('Failed to parse ytdlp-config.json:', err.message);
    }
  }
  // Default fallback config
  return {
    format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    audioFormat: 'mp3',
    audioQuality: '5',
    outtmpl: '%(title)s [%(id)s].%(ext)s',
    extraArgs: ['--no-playlist', '--no-mtime']
  };
}

// Helper to resolve the binary path
function getYtDlpBinary() {
  const localName = process.platform === 'win32' ? 'yt-dlp.exe' : './yt-dlp';
  const binaryPath = path.resolve(__dirname, localName);
  if (!fs.existsSync(binaryPath)) {
    throw new Error('yt-dlp binary not found. Please run "node download-ytdlp.js" to download it.');
  }
  return binaryPath;
}

/**
 * Searches YouTube for videos, playlists, or channels
 * @param {string} query - The search string
 */
export async function searchYouTube(query) {
  logger.info(`Searching YouTube for: "${query}"`);
  const r = await ytSearch(query);
  return {
    videos: r.videos.slice(0, 15),
    playlists: r.playlists.slice(0, 5),
    channels: r.accounts.slice(0, 5)
  };
}

/**
 * Starts downloading a YouTube video or playlist in the background
 * @param {string} url - YouTube URL to download
 * @param {string} type - 'video' or 'audio'
 * @param {function} onComplete - Callback function(downloadJob)
 * @param {function} onError - Callback function(downloadJob, error)
 */
export function startDownload(url, type = 'video', onComplete = null, onError = null) {
  const binaryPath = getYtDlpBinary();
  const ytConfig = getYtDlpConfig();
  
  const cookiesPath = path.resolve(__dirname, 'cookies.txt');
  const hasCookies = fs.existsSync(cookiesPath);

  // Generate unique download ID
  const downloadId = `dl_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  
  const job = {
    id: downloadId,
    url,
    title: 'Loading metadata...',
    type,
    status: 'downloading',
    progress: 0,
    speed: '--',
    eta: '--',
    outputFile: null,
    process: null,
    error: null,
    addedAt: new Date().toISOString()
  };

  activeDownloads.set(downloadId, job);
  logger.info(`Starting YouTube background download (${type}): ${url} (ID: ${downloadId})`);

  // Build CLI arguments
  const args = [];
  
  if (hasCookies) {
    args.push('--cookies', cookiesPath);
  }

  // Set Output Template
  const outTemplate = path.join(config.downloadsDir, ytConfig.outtmpl || '%(title)s [%(id)s].%(ext)s');
  args.push('-o', outTemplate);

  // Format selection
  if (type === 'audio') {
    args.push('-x', '--audio-format', ytConfig.audioFormat || 'mp3', '--audio-quality', ytConfig.audioQuality || '5');
  } else {
    args.push('-f', ytConfig.format || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best');
  }

  // Add extra static arguments from config
  if (Array.isArray(ytConfig.extraArgs)) {
    args.push(...ytConfig.extraArgs);
  }

  // Resolve final filename via yt-dlp --get-filename first
  try {
    const filenameArgs = [...args, '--get-filename', url];
    // Remove output option (-o) since --get-filename already incorporates output template
    const oIndex = filenameArgs.indexOf('-o');
    if (oIndex !== -1) {
      filenameArgs.splice(oIndex, 2);
    }
    
    // Resolve filename synchronously
    const stdout = execSync(`"${binaryPath}" ${filenameArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ')}`, { encoding: 'utf8' });
    const outputFilename = stdout.trim().split('\n')[0]; // Take first video if it is a playlist
    
    // Resolve absolute path to downloads folder
    job.outputFile = path.resolve(config.downloadsDir, path.basename(outputFilename));
    job.title = path.basename(outputFilename, path.extname(outputFilename));
  } catch (err) {
    logger.warn(`Failed to resolve output filename with --get-filename: ${err.message}. Relying on fallback parsing.`);
    job.title = url;
  }

  // Append URL as final argument
  args.push(url);

  // Spawn yt-dlp child process
  const child = spawn(binaryPath, args, { cwd: __dirname });
  job.process = child;

  let stderrOutput = '';

  child.stdout.on('data', (data) => {
    const output = data.toString();
    
    // Parse progress output
    // Standard format: [download]  12.5% of 10.00MiB at  2.00MiB/s ETA 00:04
    const progressMatch = output.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+([^\s]+)\s+at\s+([^\s]+)\s+ETA\s+([^\s]+)/);
    if (progressMatch) {
      job.progress = parseFloat(progressMatch[1]);
      job.speed = progressMatch[3];
      job.eta = progressMatch[4];
      
      // Update cache
      activeDownloads.set(downloadId, job);
    }

    // Capture title if we couldn't resolve it via --get-filename
    if (job.title === 'Loading metadata...' || job.title === url) {
      const titleMatch = output.match(/\[youtube\]\s+([a-zA-Z0-9_-]{11}):\s+Downloading\s+webpage/);
      if (titleMatch) {
        // If we found the video ID, let's update title temporarily
        job.title = `Video [${titleMatch[1]}]`;
        activeDownloads.set(downloadId, job);
      }
    }
    
    // Update destination file if resolved from download logs
    const destMatch = output.match(/\[download\]\s+Destination:\s+(.+)/);
    if (destMatch && !job.outputFile) {
      const fullPath = destMatch[1].trim();
      job.outputFile = path.resolve(config.downloadsDir, path.basename(fullPath));
      job.title = path.basename(fullPath, path.extname(fullPath));
      activeDownloads.set(downloadId, job);
    }

    // Capture merger formats destination file
    const mergerMatch = output.match(/\[Merger\]\s+Merging\s+formats\s+into\s+"(.+)"/);
    if (mergerMatch) {
      const fullPath = mergerMatch[1].trim();
      job.outputFile = path.resolve(config.downloadsDir, path.basename(fullPath));
      job.title = path.basename(fullPath, path.extname(fullPath));
      activeDownloads.set(downloadId, job);
    }
  });

  child.stderr.on('data', (data) => {
    stderrOutput += data.toString();
  });

  child.on('close', (code) => {
    job.process = null; // process ended
    
    if (code === 0) {
      job.status = 'completed';
      job.progress = 100;
      job.speed = '0';
      job.eta = '00:00';
      
      // Verify file exists
      if (!job.outputFile) {
        // Fallback file scan inside download folder
        job.outputFile = scanFolderForDownloadedUrl(url);
      }
      
      if (job.outputFile && fs.existsSync(job.outputFile)) {
        job.title = path.basename(job.outputFile);
      } else {
        job.status = 'failed';
        job.error = 'Downloaded file was not found on server disk.';
      }
      
      activeDownloads.set(downloadId, job);
      logger.success(`YouTube download completed successfully: ${job.title} (ID: ${downloadId})`);
      if (onComplete) onComplete(job);
    } else {
      job.status = 'failed';
      job.error = stderrOutput.trim() || `yt-dlp exited with non-zero code ${code}`;
      activeDownloads.set(downloadId, job);
      logger.error(`YouTube download failed for URL ${url}: ${job.error}`);
      if (onError) onError(job, job.error);
    }
  });

  return job;
}

/**
 * Searches the download directory for files matching the youtube url ID
 * @param {string} url - YouTube URL
 * @returns {string|null} - Absolute file path if found
 */
function scanFolderForDownloadedUrl(url) {
  const match = url.match(/(?:v=|\/)([a-zA-Z0-9_-]{11})/);
  if (!match) return null;
  const vidId = match[1];

  try {
    const files = fs.readdirSync(config.downloadsDir);
    for (const file of files) {
      if (file.includes(`[${vidId}]`)) {
        return path.join(config.downloadsDir, file);
      }
    }
  } catch (err) {
    logger.error('Failed to scan folder for downloaded URL:', err.message);
  }
  return null;
}

/**
 * Retrieves the status list of all active or completed downloads
 */
export function getActiveDownloads() {
  const list = [];
  for (const job of activeDownloads.values()) {
    // Exclude the process instance to prevent JSON serialization errors
    const { process, ...sanitizedJob } = job;
    list.push(sanitizedJob);
  }
  // Sort: newest first
  return list.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
}

/**
 * Cancels/kills an active download process
 * @param {string} id - Download job ID
 */
export function cancelDownload(id) {
  const job = activeDownloads.get(id);
  if (job && job.process && job.status === 'downloading') {
    logger.warn(`Cancelling active download process for Job: ${id}`);
    job.process.kill('SIGTERM');
    job.status = 'failed';
    job.error = 'Download cancelled by user.';
    activeDownloads.set(id, job);
    return true;
  }
  return false;
}

export default {
  searchYouTube,
  startDownload,
  getActiveDownloads,
  cancelDownload
};
