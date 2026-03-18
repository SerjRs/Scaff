/**
 * Split test-speech-10s.wav into 3 individual stereo WAV chunks (~3s each).
 *
 * Output: test-speech-chunk-00.wav, test-speech-chunk-01.wav, test-speech-chunk-02.wav
 *
 * Each chunk is a valid stereo 16-bit 16kHz WAV file.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.join(__dirname, "test-speech-10s.wav");
const CHUNK_COUNT = 3;

if (!fs.existsSync(INPUT)) {
  console.error(`Missing fixture: ${INPUT}`);
  process.exit(1);
}

const buf = fs.readFileSync(INPUT);

// Parse WAV header
const riff = buf.toString("ascii", 0, 4);
if (riff !== "RIFF") throw new Error("Not a RIFF file");

const fmt = buf.toString("ascii", 12, 16);
if (fmt !== "fmt ") throw new Error("Missing fmt chunk");

const fmtSize = buf.readUInt32LE(16);
const audioFormat = buf.readUInt16LE(20); // 1 = PCM
const numChannels = buf.readUInt16LE(22);
const sampleRate = buf.readUInt32LE(24);
const byteRate = buf.readUInt32LE(28);
const blockAlign = buf.readUInt16LE(32);
const bitsPerSample = buf.readUInt16LE(34);

console.log(`Input: ${numChannels}ch, ${sampleRate}Hz, ${bitsPerSample}bit, format=${audioFormat}`);

// Find "data" chunk
let dataOffset = 12;
let dataSize = 0;
while (dataOffset < buf.length - 8) {
  const chunkId = buf.toString("ascii", dataOffset, dataOffset + 4);
  const chunkSize = buf.readUInt32LE(dataOffset + 4);
  if (chunkId === "data") {
    dataSize = chunkSize;
    dataOffset += 8; // skip chunk header, now points to PCM data
    break;
  }
  dataOffset += 8 + chunkSize;
  // Word-align
  if (chunkSize % 2 !== 0) dataOffset++;
}

if (dataSize === 0) throw new Error("No data chunk found");

console.log(`PCM data: ${dataSize} bytes at offset ${dataOffset}`);

const pcmData = buf.subarray(dataOffset, dataOffset + dataSize);
const bytesPerChunk = Math.floor(pcmData.length / CHUNK_COUNT);
// Align to block boundary
const alignedBytesPerChunk = bytesPerChunk - (bytesPerChunk % blockAlign);

for (let i = 0; i < CHUNK_COUNT; i++) {
  const start = i * alignedBytesPerChunk;
  const end = i === CHUNK_COUNT - 1 ? pcmData.length : start + alignedBytesPerChunk;
  const chunkPcm = pcmData.subarray(start, end);

  // Build WAV header for this chunk
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + chunkPcm.length, 4); // file size - 8
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(chunkPcm.length, 40);

  const outPath = path.join(__dirname, `test-speech-chunk-${String(i).padStart(2, "0")}.wav`);
  fs.writeFileSync(outPath, Buffer.concat([header, chunkPcm]));

  const durationSec = chunkPcm.length / byteRate;
  console.log(`Wrote ${outPath} (${chunkPcm.length} bytes, ~${durationSec.toFixed(1)}s)`);
}

console.log("Done — 3 chunks created.");
