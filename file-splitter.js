import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';

/**
 * Compresses a single file into a cross-platform ZIP archive using streams
 * @param {string} sourcePath - Absolute path to the source file
 * @param {string} destZipPath - Absolute path to the destination ZIP file
 * @returns {Promise<string>} - Resolves to the destination ZIP path when complete
 */
export function zipFile(sourcePath, destZipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZipPath);
    const archive = archiver('zip', {
      zlib: { level: 6 } // Good compression to speed ratio
    });

    output.on('close', () => {
      resolve(destZipPath);
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);
    
    // Add the file to zip using its base name
    archive.file(sourcePath, { name: path.basename(sourcePath) });
    
    archive.finalize();
  });
}

/**
 * Splits a file into fixed-size binary chunks sequentially using streams
 * @param {string} filePath - Path of the file to split
 * @param {number} chunkSizeBytes - Max size per chunk in bytes
 * @param {string} outputDir - Directory where chunks will be written
 * @returns {Promise<string[]>} - Resolves to an array of output chunk paths
 */
export function splitFile(filePath, chunkSizeBytes, outputDir) {
  return new Promise((resolve, reject) => {
    const filename = path.basename(filePath);
    const readStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 64 });
    const chunkPaths = [];
    const writeStreams = [];
    
    let chunkIndex = 1;
    let currentChunkSize = 0;
    let writeStream = null;

    function writeToChunk(dataSlice) {
      if (!writeStream) {
        // Name chunks using standard .001, .002, .003 format
        const suffix = `.${String(chunkIndex).padStart(3, '0')}`;
        const chunkPath = path.join(outputDir, filename + suffix);
        chunkPaths.push(chunkPath);
        writeStream = fs.createWriteStream(chunkPath);
        writeStreams.push(writeStream);
        writeStream.on('error', (err) => {
          readStream.destroy();
          reject(err);
        });
      }
      writeStream.write(dataSlice);
      currentChunkSize += dataSlice.length;
    }

    readStream.on('data', (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const remainingSpace = chunkSizeBytes - currentChunkSize;
        const toWriteLength = Math.min(chunk.length - offset, remainingSpace);
        
        const dataSlice = chunk.subarray(offset, offset + toWriteLength);
        writeToChunk(dataSlice);
        
        offset += toWriteLength;
        
        // Chunk boundary reached
        if (currentChunkSize >= chunkSizeBytes) {
          writeStream.end();
          writeStream = null;
          chunkIndex++;
          currentChunkSize = 0;
        }
      }
    });

    readStream.on('end', () => {
      if (writeStream) {
        writeStream.end();
      }
      
      // Wait for all chunk write streams to finish flushing to disk
      const finishPromises = writeStreams.map(stream => {
        return new Promise(res => {
          if (stream.writableFinished) {
            res();
          } else {
            stream.on('finish', res);
            stream.on('close', res);
          }
        });
      });

      Promise.all(finishPromises)
        .then(() => {
          resolve(chunkPaths);
        })
        .catch(reject);
    });

    readStream.on('error', (err) => {
      for (const stream of writeStreams) {
        stream.destroy();
      }
      reject(err);
    });
  });
}

/**
 * Safely deletes a list of files from disk (e.g. temporary zip and chunks)
 * @param {string[]} filePaths - Array of absolute paths to delete
 */
export function cleanupFiles(filePaths) {
  for (const filePath of filePaths) {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Failed to delete temp file ${filePath}:`, err.message);
      }
    }
  }
}

export default {
  zipFile,
  splitFile,
  cleanupFiles
};
