#!/usr/bin/env node
/**
 * Generate test WAV fixtures for audio pipeline testing.
 *
 * Committed fixtures use 8 kHz to stay under 100 KB each.
 * The E2E test script generates its own 44.1 kHz WAVs at runtime.
 *
 * Output:
 *   fixtures/test-stereo-3s.wav     — 3s stereo WAV (~96 KB)
 *   fixtures/test-chunk-00.wav      — 1s stereo WAV chunk (~32 KB)
 *   fixtures/test-chunk-01.wav      — 1s stereo WAV chunk (~32 KB)
 *   fixtures/test-chunk-02.wav      — 1s stereo WAV chunk (~32 KB)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_RATE = 8000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

function buildStereoWav(durationSecs, freqLeft = 440, freqRight = 880) {
  const numFrames = SAMPLE_RATE * durationSecs;
  const pcmData = Buffer.alloc(numFrames * CHANNELS * BYTES_PER_SAMPLE);

  for (let i = 0; i < numFrames; i++) {
    const t = i / SAMPLE_RATE;
    const leftSample = Math.round(Math.sin(2 * Math.PI * freqLeft * t) * 16000);
    const rightSample = Math.round(Math.sin(2 * Math.PI * freqRight * t) * 16000);
    pcmData.writeInt16LE(leftSample, i * 4);
    pcmData.writeInt16LE(rightSample, i * 4 + 2);
  }

  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

// Generate 3s full file (~96 KB)
console.log("Generating test-stereo-3s.wav ...");
const full = buildStereoWav(3, 440, 880);
fs.writeFileSync(path.join(__dirname, "test-stereo-3s.wav"), full);
console.log(`  ${full.length} bytes (${(full.length / 1024).toFixed(0)} KB)`);

// Generate 3 x 1s chunks (~32 KB each)
for (let i = 0; i < 3; i++) {
  const freq = 300 + i * 200;
  const chunk = buildStereoWav(1, freq, freq + 100);
  const name = `test-chunk-${String(i).padStart(2, "0")}.wav`;
  fs.writeFileSync(path.join(__dirname, name), chunk);
  console.log(`  ${name}: ${chunk.length} bytes (${(chunk.length / 1024).toFixed(0)} KB)`);
}

console.log("Done.");
