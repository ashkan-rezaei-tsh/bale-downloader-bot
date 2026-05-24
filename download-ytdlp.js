import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function downloadYtDlp() {
  const platform = process.platform;
  const arch = process.arch;
  let filename = '';

  console.log(`Detecting system architecture... Platform: ${platform}, Arch: ${arch}`);

  if (platform === 'win32') {
    filename = 'yt-dlp.exe';
  } else if (platform === 'linux') {
    if (arch === 'arm64' || arch === 'aarch64') {
      filename = 'yt-dlp_linux_aarch64';
    } else {
      filename = 'yt-dlp_linux';
    }
  } else if (platform === 'darwin') {
    filename = 'yt-dlp_macos';
  } else {
    console.error(`Unsupported platform: ${platform}`);
    process.exit(1);
  }

  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`;
  const localName = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const destPath = path.join(__dirname, localName);

  console.log(`Downloading yt-dlp from: ${url}`);
  console.log(`Target path: ${destPath}`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buffer));
    console.log('✅ Download completed successfully!');

    if (platform !== 'win32') {
      console.log('Setting executable permission (chmod +x)...');
      fs.chmodSync(destPath, '755');
    }

    console.log('🎉 yt-dlp is ready for use.');
  } catch (err) {
    console.error('❌ Failed to download yt-dlp binary:', err.message);
    process.exit(1);
  }
}

downloadYtDlp();
