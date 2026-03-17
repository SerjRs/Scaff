/**
 * Pure-JS WAV utilities — concatenation and stereo→mono channel splitting.
 *
 * No external dependencies (no FFmpeg, no wavefile npm package).
 * Handles standard PCM WAV files (16-bit, 44100 Hz default).
 *
 * @see workspace/pipeline/InProgress/025e-transcription-worker/SPEC.md
 */

import fs from "node:fs";

// ---------------------------------------------------------------------------
// WAV header constants
// ---------------------------------------------------------------------------

const RIFF_MAGIC = 0x46464952; // "RIFF" little-endian
const WAVE_MAGIC = 0x45564157; // "WAVE" little-endian
const FMT_MAGIC = 0x20746d66; // "fmt " little-endian
const DATA_MAGIC = 0x61746164; // "data" little-endian
const PCM_FORMAT = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WavHeader {
  numChannels: number;
  sampleRate: number;
  bitsPerSample: number;
  audioFormat: number;
  byteRate: number;
  blockAlign: number;
  dataOffset: number;
  dataSize: number;
}

export interface WavFile {
  header: WavHeader;
  data: Buffer;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse a WAV buffer and return header + raw PCM data. */
export function parseWav(buf: Buffer): WavFile {
  if (buf.length < 44) {
    throw new Error("WAV too short: must be at least 44 bytes");
  }

  const riff = buf.readUInt32LE(0);
  if (riff !== RIFF_MAGIC) {
    throw new Error("Not a RIFF file");
  }

  const wave = buf.readUInt32LE(8);
  if (wave !== WAVE_MAGIC) {
    throw new Error("Not a WAVE file");
  }

  // Find fmt chunk
  let offset = 12;
  let fmtFound = false;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;

  while (offset < buf.length - 8) {
    const chunkId = buf.readUInt32LE(offset);
    const chunkSize = buf.readUInt32LE(offset + 4);

    if (chunkId === FMT_MAGIC) {
      audioFormat = buf.readUInt16LE(offset + 8);
      numChannels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      byteRate = buf.readUInt32LE(offset + 16);
      blockAlign = buf.readUInt16LE(offset + 20);
      bitsPerSample = buf.readUInt16LE(offset + 22);
      fmtFound = true;
    }

    if (chunkId === DATA_MAGIC) {
      if (!fmtFound) throw new Error("data chunk found before fmt chunk");
      return {
        header: { numChannels, sampleRate, bitsPerSample, audioFormat, byteRate, blockAlign, dataOffset: offset + 8, dataSize: chunkSize },
        data: buf.subarray(offset + 8, offset + 8 + chunkSize),
      };
    }

    offset += 8 + chunkSize;
    // WAV chunks are word-aligned
    if (chunkSize % 2 !== 0) offset += 1;
  }

  throw new Error("No data chunk found in WAV");
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Build a complete WAV buffer from raw PCM data and format params. */
export function buildWav(
  pcmData: Buffer,
  numChannels: number,
  sampleRate: number,
  bitsPerSample: number,
): Buffer {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.writeUInt32LE(RIFF_MAGIC, 0);         // "RIFF"
  header.writeUInt32LE(fileSize, 4);            // file size - 8
  header.writeUInt32LE(WAVE_MAGIC, 8);          // "WAVE"
  header.writeUInt32LE(FMT_MAGIC, 12);          // "fmt "
  header.writeUInt32LE(16, 16);                 // fmt chunk size
  header.writeUInt16LE(PCM_FORMAT, 20);         // audio format (PCM)
  header.writeUInt16LE(numChannels, 22);        // channels
  header.writeUInt32LE(sampleRate, 24);         // sample rate
  header.writeUInt32LE(byteRate, 28);           // byte rate
  header.writeUInt16LE(blockAlign, 32);         // block align
  header.writeUInt16LE(bitsPerSample, 34);      // bits per sample
  header.writeUInt32LE(DATA_MAGIC, 36);         // "data"
  header.writeUInt32LE(dataSize, 40);           // data size

  return Buffer.concat([header, pcmData]);
}

// ---------------------------------------------------------------------------
// Channel splitting (stereo → two mono)
// ---------------------------------------------------------------------------

export interface SplitResult {
  left: Buffer;   // Complete mono WAV (left channel / user)
  right: Buffer;  // Complete mono WAV (right channel / others)
}

/**
 * Split a stereo WAV into two mono WAV buffers (left + right).
 * Assumes 16-bit PCM stereo input.
 */
export function splitStereoToMono(stereoBuf: Buffer): SplitResult {
  const wav = parseWav(stereoBuf);

  if (wav.header.numChannels !== 2) {
    throw new Error(`Expected stereo (2 channels), got ${wav.header.numChannels}`);
  }
  if (wav.header.bitsPerSample !== 16) {
    throw new Error(`Expected 16-bit audio, got ${wav.header.bitsPerSample}-bit`);
  }

  const bytesPerSample = wav.header.bitsPerSample / 8; // 2
  const frameSizeBytes = bytesPerSample * 2; // 4 bytes per stereo frame
  const numFrames = Math.floor(wav.data.length / frameSizeBytes);

  const leftData = Buffer.alloc(numFrames * bytesPerSample);
  const rightData = Buffer.alloc(numFrames * bytesPerSample);

  for (let i = 0; i < numFrames; i++) {
    const srcOffset = i * frameSizeBytes;
    const dstOffset = i * bytesPerSample;
    wav.data.copy(leftData, dstOffset, srcOffset, srcOffset + bytesPerSample);
    wav.data.copy(rightData, dstOffset, srcOffset + bytesPerSample, srcOffset + frameSizeBytes);
  }

  return {
    left: buildWav(leftData, 1, wav.header.sampleRate, wav.header.bitsPerSample),
    right: buildWav(rightData, 1, wav.header.sampleRate, wav.header.bitsPerSample),
  };
}

// ---------------------------------------------------------------------------
// Concatenation
// ---------------------------------------------------------------------------

/**
 * Concatenate multiple WAV files into a single WAV.
 * All inputs must share the same format (channels, sample rate, bit depth).
 */
export function concatenateWavFiles(filePaths: string[]): Buffer {
  if (filePaths.length === 0) {
    throw new Error("No WAV files to concatenate");
  }

  const wavs = filePaths.map((fp) => {
    const buf = fs.readFileSync(fp);
    return parseWav(buf);
  });

  // Validate all have same format
  const ref = wavs[0].header;
  for (let i = 1; i < wavs.length; i++) {
    const h = wavs[i].header;
    if (h.numChannels !== ref.numChannels || h.sampleRate !== ref.sampleRate || h.bitsPerSample !== ref.bitsPerSample) {
      throw new Error(
        `WAV format mismatch at file ${i}: ` +
        `expected ${ref.numChannels}ch/${ref.sampleRate}Hz/${ref.bitsPerSample}bit, ` +
        `got ${h.numChannels}ch/${h.sampleRate}Hz/${h.bitsPerSample}bit`,
      );
    }
  }

  const totalData = Buffer.concat(wavs.map((w) => w.data));
  return buildWav(totalData, ref.numChannels, ref.sampleRate, ref.bitsPerSample);
}

/**
 * Concatenate WAV buffers (already in memory) into a single WAV.
 */
export function concatenateWavBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) {
    throw new Error("No WAV buffers to concatenate");
  }

  const wavs = buffers.map((buf) => parseWav(buf));

  const ref = wavs[0].header;
  for (let i = 1; i < wavs.length; i++) {
    const h = wavs[i].header;
    if (h.numChannels !== ref.numChannels || h.sampleRate !== ref.sampleRate || h.bitsPerSample !== ref.bitsPerSample) {
      throw new Error(`WAV format mismatch at buffer ${i}`);
    }
  }

  const totalData = Buffer.concat(wavs.map((w) => w.data));
  return buildWav(totalData, ref.numChannels, ref.sampleRate, ref.bitsPerSample);
}
