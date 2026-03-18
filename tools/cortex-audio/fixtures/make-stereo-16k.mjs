/**
 * Convert a mono WAV to stereo 16kHz 16-bit PCM.
 * Left channel = speech, Right channel = silence.
 *
 * Usage: node make-stereo-16k.mjs <input.wav> <output.wav>
 */
import fs from "node:fs";

const [,, inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("Usage: node make-stereo-16k.mjs <input.wav> <output.wav>");
  process.exit(1);
}

const buf = fs.readFileSync(inputPath);

// Parse input WAV header
const numChannels = buf.readUInt16LE(22);
const srcRate = buf.readUInt32LE(24);
const bitsPerSample = buf.readUInt16LE(34);

if (numChannels !== 1) throw new Error(`Expected mono input, got ${numChannels} channels`);
if (bitsPerSample !== 16) throw new Error(`Expected 16-bit, got ${bitsPerSample}-bit`);

// Find data chunk
let dataOffset = 12;
while (dataOffset < buf.length - 8) {
  const chunkId = buf.toString("ascii", dataOffset, dataOffset + 4);
  const chunkSize = buf.readUInt32LE(dataOffset + 4);
  if (chunkId === "data") {
    dataOffset += 8;
    break;
  }
  dataOffset += 8 + chunkSize;
  if (chunkSize % 2 !== 0) dataOffset += 1;
}

const srcSamples = buf.subarray(dataOffset);
const srcCount = srcSamples.length / 2; // 16-bit = 2 bytes per sample

// Resample to 16000 Hz using linear interpolation
const TARGET_RATE = 16000;
const ratio = srcRate / TARGET_RATE;
const dstCount = Math.floor(srcCount / ratio);

const dstSamples = Buffer.alloc(dstCount * 2);
for (let i = 0; i < dstCount; i++) {
  const srcPos = i * ratio;
  const idx = Math.floor(srcPos);
  const frac = srcPos - idx;
  const s0 = srcSamples.readInt16LE(idx * 2);
  const s1 = idx + 1 < srcCount ? srcSamples.readInt16LE((idx + 1) * 2) : s0;
  const val = Math.round(s0 + frac * (s1 - s0));
  dstSamples.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2);
}

// Build stereo WAV (left = speech, right = silence)
const stereoDataSize = dstCount * 4; // 2 channels * 2 bytes
const stereoData = Buffer.alloc(stereoDataSize);
for (let i = 0; i < dstCount; i++) {
  const sample = dstSamples.readInt16LE(i * 2);
  stereoData.writeInt16LE(sample, i * 4);       // left
  stereoData.writeInt16LE(0, i * 4 + 2);        // right = silence
}

// Build WAV header (44 bytes)
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + stereoDataSize, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);           // fmt chunk size
header.writeUInt16LE(1, 20);            // PCM
header.writeUInt16LE(2, 22);            // stereo
header.writeUInt32LE(TARGET_RATE, 24);  // sample rate
header.writeUInt32LE(TARGET_RATE * 2 * 2, 28);  // byte rate
header.writeUInt16LE(4, 32);            // block align (2ch * 2bytes)
header.writeUInt16LE(16, 34);           // bits per sample
header.write("data", 36);
header.writeUInt32LE(stereoDataSize, 40);

fs.writeFileSync(outputPath, Buffer.concat([header, stereoData]));

const durationSec = (dstCount / TARGET_RATE).toFixed(1);
console.log(`Written: ${outputPath} (stereo, 16kHz, 16-bit, ${durationSec}s)`);
