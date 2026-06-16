// Dashboard Client Logic
let token = localStorage.getItem("dashboard_token");
let currentDir = "";
let defaultChatId = "";
let lastLogCount = 0;

// SVG Icons
const icons = {
    folder: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="file-icon file-icon-dir"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
    video: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="file-icon file-icon-video"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>`,
    file: `<svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="file-icon file-icon-file"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
};

// DOM Elements
const loginContainer = document.getElementById("login-container");
const dashboardContainer = document.getElementById("dashboard-container");
const loginForm = document.getElementById("login-form");
const passwordInput = document.getElementById("password");
const loginError = document.getElementById("login-error");
const logoutBtn = document.getElementById("logout-btn");

// Navigation Tabs
const tabButtons = document.querySelectorAll(".tab-btn");
const tabViews = document.querySelectorAll(".tab-content-panel");

// DOM elements for YouTube Search & Download
const ytSearchInput = document.getElementById("yt-search-input");
const ytSearchBtn = document.getElementById("yt-search-btn");
const directDlBar = document.getElementById("direct-dl-bar");
const directDlVideoBtn = document.getElementById("direct-dl-video");
const directDlAudioBtn = document.getElementById("direct-dl-audio");
const ytResultsContainer = document.getElementById("yt-results-container");
const downloadsQueueList = document.getElementById("downloads-queue-list");

// Status components
const botPulse = document.getElementById("bot-status-pulse");
const botStatusText = document.getElementById("bot-status-text");
const botUsername = document.getElementById("bot-username");

const cpuLoadVal = document.getElementById("cpu-load-val");
const cpuProgress = document.getElementById("cpu-progress");
const cpuMeta = document.getElementById("cpu-meta");

const ramUsedVal = document.getElementById("ram-used-val");
const ramProgress = document.getElementById("ram-progress");
const ramMeta = document.getElementById("ram-meta");

const diskUsedVal = document.getElementById("disk-used-val");
const diskProgress = document.getElementById("disk-progress");
const diskMeta = document.getElementById("disk-meta");

const osPlatform = document.getElementById("os-platform");
const serverUptime = document.getElementById("server-uptime");
const downloadsPath = document.getElementById("downloads-path");

// File Explorer
const refreshFilesBtn = document.getElementById("refresh-files-btn");
const folderBreadcrumbs = document.getElementById("folder-breadcrumbs");
const filesList = document.getElementById("files-list");

// Logs
const logsConsole = document.getElementById("logs-console");
const clearLogsBtn = document.getElementById("clear-logs-btn");

// Modal Elements
const uploadModal = document.getElementById("upload-modal");
const closeModalBtn = document.getElementById("close-modal-btn");
const cancelUploadBtn = document.getElementById("cancel-upload-btn");
const uploadForm = document.getElementById("upload-form");
const modalFilename = document.getElementById("modal-filename");
const modalFilesize = document.getElementById("modal-filesize");
const modalFileIcon = document.getElementById("modal-file-icon");
const modalChatId = document.getElementById("modal-chat-id");
const modalCaption = document.getElementById("modal-caption");

// Loading overlay
const loadingOverlay = document.getElementById("loading-overlay");
const loadingOverlayFilename = document.getElementById("loading-overlay-filename");

let activeUploadFile = null;

// Initialization
document.addEventListener("DOMContentLoaded", () => {
    if (token) {
        showDashboard();
    } else {
        showLogin();
    }

    // Bind login form
    loginForm.addEventListener("submit", handleLoginSubmit);
    logoutBtn.addEventListener("click", handleLogout);

    // File explorer bindings
    refreshFilesBtn.addEventListener("click", () => fetchFiles(currentDir));

    // Modal actions
    closeModalBtn.addEventListener("click", hideModal);
    cancelUploadBtn.addEventListener("click", hideModal);
    uploadForm.addEventListener("submit", handleUploadSubmit);

    // Tab switching bindings
    tabButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            const targetTab = btn.getAttribute("data-tab");
            
            tabButtons.forEach(b => b.classList.remove("active"));
            tabViews.forEach(v => v.classList.add("hidden"));
            
            btn.classList.add("active");
            const targetView = document.getElementById(targetTab);
            if (targetView) {
                targetView.classList.remove("hidden");
            }
            
            // Refresh content based on tab selection
            if (targetTab === "files-tab-view") {
                fetchFiles(currentDir);
            } else if (targetTab === "youtube-tab-view") {
                fetchActiveDownloads();
            }
        });
    });

    // YouTube search bindings
    if (ytSearchBtn) {
        ytSearchBtn.addEventListener("click", performSearch);
    }
    if (ytSearchInput) {
        ytSearchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") performSearch();
        });
        ytSearchInput.addEventListener("input", handleSearchInput);
    }
    if (directDlVideoBtn) {
        directDlVideoBtn.addEventListener("click", () => triggerDownloadFromInput("video"));
    }
    if (directDlAudioBtn) {
        directDlAudioBtn.addEventListener("click", () => triggerDownloadFromInput("audio"));
    }
});

// Format Byte Size
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

// Format seconds into uptime string
function formatDuration(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(" ");
}

// API fetch wrapper with automatic auth token inclusion
async function apiFetch(endpoint, options = {}) {
    const headers = {
        "Content-Type": "application/json",
        ...options.headers,
    };

    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }

    const res = await fetch(endpoint, {
        ...options,
        headers,
    });

    if (res.status === 401 || res.status === 403) {
        // Session expired/unauthorized
        handleLogout();
        throw new Error("Unauthorized");
    }

    return res;
}

// Toggle Containers
function showLogin() {
    loginContainer.classList.remove("hidden");
    dashboardContainer.classList.add("hidden");
}

let downloadsInterval = null;

function showDashboard() {
    loginContainer.classList.add("hidden");
    dashboardContainer.classList.remove("hidden");

    // Trigger immediate loads
    fetchStatus();
    fetchFiles("");
    fetchLogs();
    fetchActiveDownloads();

    // Set up intervals
    setInterval(fetchStatus, 5000);
    setInterval(fetchLogs, 5000);
    
    if (downloadsInterval) clearInterval(downloadsInterval);
    downloadsInterval = setInterval(fetchActiveDownloads, 2000);
}

// Authentication handlers
async function handleLoginSubmit(e) {
    e.preventDefault();
    const password = passwordInput.value;
    loginError.classList.add("hidden");

    try {
        const res = await fetch("/api/auth/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
        });

        const data = await res.json();
        if (data.success) {
            token = data.token;
            localStorage.setItem("dashboard_token", token);
            showDashboard();
        } else {
            loginError.innerText = data.error || "Authentication failed.";
            loginError.classList.remove("hidden");
        }
    } catch (err) {
        loginError.innerText = "Network error verifying credentials.";
        loginError.classList.remove("hidden");
    }
}

function handleLogout() {
    token = null;
    localStorage.removeItem("dashboard_token");
    if (downloadsInterval) {
        clearInterval(downloadsInterval);
    }
    location.reload();
}

// Fetch server status metrics
async function fetchStatus() {
    try {
        const res = await apiFetch("/api/status");
        const data = await res.json();

        // Update bot details
        if (data.bot.status === "Connected") {
            botPulse.className = "status-pulse connected";
            botStatusText.innerText = "Online";
            botUsername.innerText = `@${data.bot.info.username}`;
        } else {
            botPulse.className = "status-pulse disconnected";
            botStatusText.innerText = data.bot.status;
            botUsername.innerText = "";
        }

        defaultChatId = data.bot.defaultChatId;

        // Update CPU
        cpuLoadVal.innerText = data.system.cpu.load.toFixed(1);
        cpuProgress.style.width = `${data.system.cpu.load}%`;
        cpuMeta.innerText = `Clock speed: ${data.system.cpu.speed} GHz`;

        // Update RAM
        const ramTotalGB = data.system.memory.total / 1024 ** 3;
        const ramUsedGB = data.system.memory.active / 1024 ** 3;
        const ramAvailGB = data.system.memory.available / 1024 ** 3;
        const ramPercent = (data.system.memory.active / data.system.memory.total) * 100;

        ramUsedVal.innerText = ramUsedGB.toFixed(2);
        ramProgress.style.width = `${ramPercent}%`;
        ramMeta.innerText = `Available: ${ramAvailGB.toFixed(2)} GB / ${ramTotalGB.toFixed(2)} GB`;

        // Update Disk
        if (data.system.disk) {
            const diskTotalGB = data.system.disk.size / 1024 ** 3;
            const diskAvailGB = data.system.disk.available / 1024 ** 3;
            diskUsedVal.innerText = data.system.disk.usePercent.toFixed(1);
            diskProgress.style.width = `${data.system.disk.usePercent}%`;
            diskMeta.innerText = `Free: ${diskAvailGB.toFixed(2)} GB / ${diskTotalGB.toFixed(2)} GB`;
        } else {
            diskUsedVal.innerText = "N/A";
            diskProgress.style.width = "0%";
            diskMeta.innerText = "Disk stats unavailable";
        }

        // Server Info
        osPlatform.innerText = `${data.system.platform} (${data.system.release})`;
        serverUptime.innerText = formatDuration(data.system.uptime);
        downloadsPath.innerText = data.config.downloadsDir;
        downloadsPath.title = data.config.downloadsDir;
    } catch (err) {
        console.error("Failed to load server status:", err);
    }
}

// Fetch logs
async function fetchLogs() {
    try {
        const res = await apiFetch("/api/logs");
        const data = await res.json();

        // Only render if count has changed
        if (data.logs.length !== lastLogCount) {
            lastLogCount = data.logs.length;

            // Determine if scrolled to bottom before appending
            const isScrolledToBottom =
                logsConsole.scrollHeight - logsConsole.clientHeight <= logsConsole.scrollTop + 30;

            logsConsole.innerHTML = "";
            if (data.logs.length === 0) {
                logsConsole.innerHTML =
                    '<div class="log-line info">[SYSTEM] Console active. Waiting for entries.</div>';
            } else {
                data.logs.forEach((log) => {
                    const div = document.createElement("div");

                    // Detect type for color styling
                    if (log.includes("[INFO]")) {
                        div.className = "log-line info";
                    } else if (log.includes("[SUCCESS]")) {
                        div.className = "log-line success";
                    } else if (log.includes("[WARN]")) {
                        div.className = "log-line warn";
                    } else if (log.includes("[ERROR]")) {
                        div.className = "log-line error";
                    } else {
                        div.className = "log-line";
                    }

                    div.innerText = log;
                    logsConsole.appendChild(div);
                });
            }

            // Auto-scroll if scrolled to bottom
            if (isScrolledToBottom) {
                logsConsole.scrollTop = logsConsole.scrollHeight;
            }
        }
    } catch (err) {
        console.error("Failed to load logs:", err);
    }
}

// File Explorer list loading
async function fetchFiles(dir) {
    // Show spinner
    filesList.innerHTML = `
    <tr>
      <td colspan="4" class="empty-loading">
        <div class="spinner"></div>
        <p>Scanning directory...</p>
      </td>
    </tr>
  `;

    try {
        const res = await apiFetch(`/api/files?dir=${encodeURIComponent(dir)}`);
        const data = await res.json();
        currentDir = data.currentPath;

        // Update Breadcrumbs
        updateBreadcrumbs(data.currentPath);

        // Populate file list
        const files = data.files;
        filesList.innerHTML = "";

        if (files.length === 0) {
            filesList.innerHTML = `
        <tr>
          <td colspan="4" class="empty-loading">
            <p>📂 This directory is empty.</p>
          </td>
        </tr>
      `;
            return;
        }

        files.forEach((file) => {
            const tr = document.createElement("tr");

            // Determine File Icon
            let icon = icons.file;
            let isVideo = false;
            if (file.isDir) {
                icon = icons.folder;
            } else {
                const ext = file.name.split(".").pop().toLowerCase();
                if (["mp4", "mov", "webm", "avi", "mkv"].includes(ext)) {
                    icon = icons.video;
                    isVideo = true;
                }
            }

            // Name Column
            const nameTd = document.createElement("td");
            nameTd.className = "col-name";

            const containerDiv = document.createElement("div");
            containerDiv.className = "file-name-cell";
            containerDiv.innerHTML = icon;

            const nameSpan = document.createElement("span");
            nameSpan.innerText = file.name;

            if (file.isDir) {
                nameSpan.className = "clickable-name";
                nameSpan.addEventListener("click", () => {
                    fetchFiles(file.relativePath);
                });
            }
            containerDiv.appendChild(nameSpan);
            nameTd.appendChild(containerDiv);

            // Size Column
            const sizeTd = document.createElement("td");
            sizeTd.className = "col-size";
            sizeTd.innerText = file.isDir ? "--" : formatBytes(file.size);

            // Date Column
            const dateTd = document.createElement("td");
            dateTd.className = "col-date";
            dateTd.innerText = new Date(file.modifiedAt).toLocaleString();

            // Actions Column
            const actionsTd = document.createElement("td");
            actionsTd.className = "col-actions";

            if (!file.isDir) {
                const sendBtn = document.createElement("button");
                sendBtn.className = "btn-action-send";
                sendBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          <span>Send</span>
        `;
                sendBtn.addEventListener("click", () => {
                    openUploadModal(file, isVideo);
                });
                actionsTd.appendChild(sendBtn);

                // Add Download Button
                const downloadBtn = document.createElement("button");
                downloadBtn.className = "btn-action-download";
                downloadBtn.title = "Download file to your local device";
                downloadBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          <span>Download</span>
        `;
                downloadBtn.addEventListener("click", () => {
                    downloadFile(file);
                });
                actionsTd.appendChild(downloadBtn);
            }

            // Safe Deletion action for files/directories
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "btn-action-delete";
            deleteBtn.title = `Delete ${file.isDir ? 'folder' : 'file'} from server`;
            deleteBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
      `;
            deleteBtn.addEventListener("click", () => {
                deleteServerFile(file.relativePath, file.isDir);
            });
            actionsTd.appendChild(deleteBtn);

            tr.appendChild(nameTd);
            tr.appendChild(sizeTd);
            tr.appendChild(dateTd);
            tr.appendChild(actionsTd);

            filesList.appendChild(tr);
        });
    } catch (err) {
        console.error("Failed to load files:", err);
        filesList.innerHTML = `
      <tr>
        <td colspan="4" class="empty-loading">
          <p class="error-text" style="margin-top:0">⚠️ Scan failed: ${err.message}</p>
        </td>
      </tr>
    `;
    }
}

// Update breadcrumbs indicators
function updateBreadcrumbs(dirPath) {
    folderBreadcrumbs.innerHTML = "";

    // Root breadcrumb
    const rootSpan = document.createElement("span");
    rootSpan.className = "breadcrumb-root";
    rootSpan.innerText = "downloads";
    rootSpan.addEventListener("click", () => {
        fetchFiles("");
    });
    folderBreadcrumbs.appendChild(rootSpan);

    if (!dirPath) return;

    const parts = dirPath.split("/").filter((p) => p !== "");
    let runningPath = "";

    parts.forEach((part, index) => {
        // Add slash separator
        const sep = document.createElement("span");
        sep.className = "breadcrumb-separator";
        sep.innerText = " / ";
        folderBreadcrumbs.appendChild(sep);

        runningPath += (index === 0 ? "" : "/") + part;
        const currentPathRef = runningPath; // closure copy

        const partSpan = document.createElement("span");
        partSpan.className = "breadcrumb-part";
        partSpan.innerText = part;

        // Bind click for nested levels
        partSpan.addEventListener("click", () => {
            fetchFiles(currentPathRef);
        });

        folderBreadcrumbs.appendChild(partSpan);
    });
}

// Handle Modal Actions
function openUploadModal(file, isVideo) {
    activeUploadFile = file;
    modalFilename.innerText = file.name;
    modalFilesize.innerText = formatBytes(file.size);
    modalFileIcon.innerHTML = isVideo ? icons.video : icons.file;

    // Set default values in fields
    modalChatId.value = defaultChatId;
    modalCaption.value = "";

    // Auto-detect type
    document.querySelector('input[name="upload-type"][value="auto"]').checked = true;

    uploadModal.classList.remove("hidden");
}

function hideModal() {
    uploadModal.classList.add("hidden");
    activeUploadFile = null;
}

// Submit upload payload
async function handleUploadSubmit(e) {
    e.preventDefault();
    if (!activeUploadFile) return;

    const chatId = modalChatId.value.trim();
    const caption = modalCaption.value.trim();
    const type = document.querySelector('input[name="upload-type"]:checked').value;

    if (!chatId) {
        alert("Please enter a target Chat ID");
        return;
    }

    // Close upload config dialog and show loading box
    const fileToUpload = activeUploadFile;
    hideModal();
    loadingOverlayFilename.innerText = fileToUpload.name;
    loadingOverlay.classList.remove("hidden");

    try {
        const res = await apiFetch("/api/upload", {
            method: "POST",
            body: JSON.stringify({
                relativePath: fileToUpload.relativePath,
                chatId,
                caption,
                type,
            }),
        });

        const data = await res.json();
        loadingOverlay.classList.add("hidden");

        if (data.success) {
            alert(`✅ Upload Successful!\nFile sent successfully to Bale chat.`);
            fetchLogs(); // refresh logs instantly
        } else {
            alert(`❌ Upload Failed: ${data.error || "Server error occurred"}`);
        }
    } catch (err) {
        loadingOverlay.classList.add("hidden");
        alert(`❌ Upload Failed: ${err.message}`);
    }
}

// Safe File/Folder deletion request
async function deleteServerFile(relativePath, isDir) {
    const typeLabel = isDir ? "folder (and all its contents)" : "file";
    if (!confirm(`Are you sure you want to permanently delete this ${typeLabel} from the server?\n\nPath: ${relativePath}`)) {
        return;
    }

    try {
        const res = await apiFetch("/api/files/delete", {
            method: "POST",
            body: JSON.stringify({ relativePath }),
        });

        const data = await res.json();
        if (data.success) {
            fetchFiles(currentDir);
        } else {
            alert(`❌ Failed to delete: ${data.error || "Server error occurred"}`);
        }
    } catch (err) {
        alert(`❌ Deletion error: ${err.message}`);
    }
}

// YouTube Search & Download logic
function handleSearchInput() {
    const val = ytSearchInput.value.trim();
    if (isYouTubeUrl(val)) {
        directDlBar.style.display = "flex";
    } else {
        directDlBar.style.display = "none";
    }
}

function isYouTubeUrl(url) {
    return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/i.test(url);
}

function triggerDownloadFromInput(type) {
    const url = ytSearchInput.value.trim();
    if (url) {
        triggerDownload(url, type);
    }
}

async function performSearch() {
    const query = ytSearchInput.value.trim();
    if (!query) return;

    ytResultsContainer.innerHTML = `
        <div class="yt-placeholder-message">
            <div class="spinner"></div>
            <p>Searching YouTube...</p>
        </div>
    `;

    try {
        const res = await apiFetch(`/api/youtube/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        renderSearchResults(data);
    } catch (err) {
        console.error("Search failed:", err);
        ytResultsContainer.innerHTML = `
            <div class="yt-placeholder-message">
                <p class="error-text" style="margin-top:0">⚠️ Search failed: ${err.message}</p>
            </div>
        `;
    }
}

function renderSearchResults(data) {
    ytResultsContainer.innerHTML = "";
    
    // Combine video search results
    if (data.videos && data.videos.length > 0) {
        data.videos.forEach(video => {
            const item = document.createElement("div");
            item.className = "yt-result-item";
            
            item.innerHTML = `
                <div class="yt-thumb-container">
                    <img class="yt-thumb" src="${video.thumbnail || video.image || 'https://via.placeholder.com/120x80'}" alt="${video.title}" referrerPolicy="no-referrer">
                    <span class="yt-duration">${video.duration ? video.duration.timestamp : (video.timestamp || '--')}</span>
                </div>
                <div class="yt-meta">
                    <div class="yt-title" title="${video.title}">${video.title}</div>
                    <div class="yt-channel">${video.author ? video.author.name : ''}</div>
                    <div class="yt-stats">${video.views ? video.views.toLocaleString() + ' views' : ''}</div>
                </div>
                <div class="yt-actions">
                    <button class="btn-primary dl-video-btn">🎥 Video</button>
                    <button class="btn-secondary dl-audio-btn">🎵 Audio</button>
                </div>
            `;
            
            // Bind actions
            item.querySelector(".dl-video-btn").addEventListener("click", () => triggerDownload(video.url, "video"));
            item.querySelector(".dl-audio-btn").addEventListener("click", () => triggerDownload(video.url, "audio"));
            
            ytResultsContainer.appendChild(item);
        });
    } else {
        ytResultsContainer.innerHTML = `
            <div class="yt-placeholder-message">
                <p>No videos found matching your query.</p>
            </div>
        `;
    }
}

async function triggerDownload(url, type) {
    try {
        const res = await apiFetch("/api/youtube/download", {
            method: "POST",
            body: JSON.stringify({ url, type }),
        });
        
        const data = await res.json();
        if (data.success) {
            // Fetch/refresh queue
            fetchActiveDownloads();
            // Clear search input if it was a direct url download
            if (isYouTubeUrl(ytSearchInput.value.trim())) {
                ytSearchInput.value = "";
                directDlBar.style.display = "none";
            }
        } else {
            alert(`❌ Failed to start download: ${data.error || "Server error occurred"}`);
        }
    } catch (err) {
        alert(`❌ Download trigger failed: ${err.message}`);
    }
}

async function fetchActiveDownloads() {
    if (!token) return;
    try {
        const res = await apiFetch("/api/youtube/downloads");
        const data = await res.json();
        renderQueueList(data.downloads);
    } catch (err) {
        console.error("Failed to fetch active downloads:", err);
    }
}

function renderQueueList(downloads) {
    if (!downloads || downloads.length === 0) {
        downloadsQueueList.innerHTML = `<div class="queue-empty-message">No active downloads.</div>`;
        return;
    }

    downloadsQueueList.innerHTML = "";
    
    downloads.forEach(job => {
        const item = document.createElement("div");
        item.className = `queue-item ${job.status}`;
        
        // Status badge styling
        let badgeClass = "badge-downloading";
        let badgeText = "Downloading";
        if (job.status === "completed") {
            badgeClass = "badge-completed";
            badgeText = "Completed";
        } else if (job.status === "failed") {
            badgeClass = "badge-failed";
            badgeText = "Failed";
        }
        
        // Footer stats text
        let statsText = "";
        if (job.status === "downloading") {
            statsText = `Speed: ${job.speed} | ETA: ${job.eta}`;
        } else if (job.status === "completed") {
            statsText = "Saved on server downloads folder";
        } else {
            statsText = "Download failed";
        }
        
        item.innerHTML = `
            <div class="queue-item-header">
                <div class="queue-item-title" title="${job.title}">${job.title}</div>
                <span class="queue-item-badge ${badgeClass}">${badgeText}</span>
            </div>
            
            <div class="queue-progress-row">
                <div class="queue-progress-bar-container">
                    <div class="queue-progress-fill" style="width: ${job.progress}%"></div>
                </div>
                <span>${job.progress.toFixed(1)}%</span>
            </div>
            
            <div class="queue-item-footer">
                <div class="queue-stats-text">${statsText}</div>
                ${job.status === 'downloading' ? `<button class="btn-cancel-dl">Cancel</button>` : ''}
            </div>
            ${job.status === 'failed' && job.error ? `<div class="queue-error-msg">${job.error}</div>` : ''}
        `;
        
        if (job.status === 'downloading') {
            item.querySelector(".btn-cancel-dl").addEventListener("click", () => cancelJob(job.id));
        }
        
        downloadsQueueList.appendChild(item);
    });
}

async function cancelJob(id) {
    if (!confirm("Are you sure you want to cancel this YouTube download job?")) return;
    try {
        const res = await apiFetch("/api/youtube/cancel", {
            method: "POST",
            body: JSON.stringify({ id }),
        });
        const data = await res.json();
        if (data.success) {
            fetchActiveDownloads();
        } else {
            alert("❌ Failed to cancel download.");
        }
    } catch (err) {
        alert(`❌ Cancellation error: ${err.message}`);
    }
}

async function downloadFile(file) {
    try {
        const res = await apiFetch("/api/files/sign", {
            method: "POST",
            body: JSON.stringify({ relativePath: file.relativePath }),
        });
        const data = await res.json();
        if (data.success && data.downloadUrl) {
            // Trigger browser download using a temporary link
            const a = document.createElement("a");
            a.href = data.downloadUrl;
            a.download = file.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } else {
            alert(`❌ Failed to generate download link: ${data.error || "Unknown error"}`);
        }
    } catch (err) {
        alert(`❌ Download error: ${err.message}`);
    }
}
