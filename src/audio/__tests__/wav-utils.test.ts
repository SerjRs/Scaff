import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseWav,
  buildWav,
  splitStereoToMono,
  concatenateWavFiles,
  concatenateWavBuffers,
} from "../wav-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wav-utils-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a stereo 16-bit 44100Hz WAV buffer with known sample data. */
function makeStereoWav(frames: number, sampleRate = 44100): Buffer {
  const bytesPerSample = 2;
  const numChannels = 2;
  const dataSize = frames * numChannels * bytesPerSample;
  const pcm = Buffer.alloc(dataSize);

  for (let i = 0; i < frames; i++) {
    // Left channel: ascending 16-bit values
    pcm.writeInt16LE(i % 32767, i * 4);
    // Right channel: descending 16-bit values
    pcm.writeInt16LE(-(i % 32767), i * 4 + 2);
  }

  return buildWav(pcm, numChannels, sampleRate, 16);
}

/** Build a mono 16-bit WAV buffer. */
function makeMonoWav(frames: number, startValue = 0, sampleRate = 44100): Buffer {
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE((startValue + i) % 32767, i * 2);
  }
  return buildWav(pcm, 1, sampleRate, 16);
}

// ---------------------------------------------------------------------------
// parseWav + buildWav
// ---------------------------------------------------------------------------

describe("parseWav / buildWav", () => {
  it("round-trips a mono WAV", () => {
    const original = makeMonoWav(100);
    const parsed = parseWav(original);

    expect(parsed.header.numChannels).toBe(1);
    expect(parsed.header.sampleRate).toBe(44100);
    expect(parsed.header.bitsPerSample).toBe(16);
    expect(parsed.header.audioFormat).toBe(1); // PCM
    expect(parsed.data.length).toBe(200); // 100 frames * 2 bytes

    const rebuilt = buildWav(parsed.data, 1, 44100, 16);
    expect(rebuilt).toEqual(original);
  });

  it("round-trips a stereo WAV", () => {
    const original = makeStereoWav(50);
    const parsed = parseWav(original);

    expect(parsed.header.numChannels).toBe(2);
    expect(parsed.data.length).toBe(200); // 50 frames * 4 bytes

    const rebuilt = buildWav(parsed.data, 2, 44100, 16);
    expect(rebuilt).toEqual(original);
  });

  it("throws on too-short buffer", () => {
    expect(() => parseWav(Buffer.alloc(10))).toThrow("WAV too short");
  });

  it("throws on non-RIFF buffer", () => {
    const buf = Buffer.alloc(44);
    buf.write("NOTARIFF", 0);
    expect(() => parseWav(buf)).toThrow("Not a RIFF file");
  });

  it("throws on non-WAVE buffer", () => {
    const buf = Buffer.alloc(44);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36, 4);
    buf.write("NOTWAV", 8);
    expect(() => parseWav(buf)).toThrow("Not a WAVE file");
  });
});

// ---------------------------------------------------------------------------
// splitStereoToMono
// ---------------------------------------------------------------------------

describe("splitStereoToMono", () => {
  it("splits stereo into left and right mono WAVs", () => {
    const frames = 100;
    const stereo = makeStereoWav(frames);
    const { left, right } = splitStereoToMono(stereo);

    const leftParsed = parseWav(left);
    const rightParsed = parseWav(right);

    // Both should be mono
    expect(leftParsed.header.numChannels).toBe(1);
    expect(rightParsed.header.numChannels).toBe(1);

    // Same sample rate
    expect(leftParsed.header.sampleRate).toBe(44100);
    expect(rightParsed.header.sampleRate).toBe(44100);

    // Correct data sizes
    expect(leftParsed.data.length).toBe(frames * 2);  // 100 frames * 2 bytes
    expect(rightParsed.data.length).toBe(frames * 2);
  });

  it("preserves correct channel data", () => {
    const frames = 10;
    const stereo = makeStereoWav(frames);
    const { left, right } = splitStereoToMono(stereo);

    const leftData = parseWav(left).data;
    const rightData = parseWav(right).data;

    // Verify left channel has ascending values
    for (let i = 0; i < frames; i++) {
      expect(leftData.readInt16LE(i * 2)).toBe(i % 32767);
    }

    // Verify right channel has descending values
    for (let i = 0; i < frames; i++) {
      expect(rightData.readInt16LE(i * 2)).toBe(-(i % 32767) || 0);
    }
  });

  it("throws on mono input", () => {
    const mono = makeMonoWav(50);
    expect(() => splitStereoToMono(mono)).toThrow("Expected stereo");
  });
});

// ---------------------------------------------------------------------------
// concatenateWavFiles
// ---------------------------------------------------------------------------

describe("concatenateWavFiles", () => {
  it("concatenates 3 mono WAV files", () => {
    const wav1 = makeMonoWav(100, 0);
    const wav2 = makeMonoWav(100, 100);
    const wav3 = makeMonoWav(100, 200);

    const paths = [
      path.join(tmpDir, "a.wav"),
      path.join(tmpDir, "b.wav"),
      path.join(tmpDir, "c.wav"),
    ];
    fs.writeFileSync(paths[0], wav1);
    fs.writeFileSync(paths[1], wav2);
    fs.writeFileSync(paths[2], wav3);

    const result = concatenateWavFiles(paths);
    const parsed = parseWav(result);

    expect(parsed.header.numChannels).toBe(1);
    expect(parsed.data.length).toBe(600); // 300 frames * 2 bytes
  });

  it("preserves sample data in correct order", () => {
    const wav1 = makeMonoWav(5, 0);
    const wav2 = makeMonoWav(5, 100);

    const paths = [
      path.join(tmpDir, "x.wav"),
      path.join(tmpDir, "y.wav"),
    ];
    fs.writeFileSync(paths[0], wav1);
    fs.writeFileSync(paths[1], wav2);

    const result = concatenateWavFiles(paths);
    const parsed = parseWav(result);

    // First 5 samples: 0, 1, 2, 3, 4
    for (let i = 0; i < 5; i++) {
      expect(parsed.data.readInt16LE(i * 2)).toBe(i);
    }
    // Next 5 samples: 100, 101, 102, 103, 104
    for (let i = 0; i < 5; i++) {
      expect(parsed.data.readInt16LE((5 + i) * 2)).toBe(100 + i);
    }
  });

  it("concatenates stereo WAV files", () => {
    const wav1 = makeStereoWav(50);
    const wav2 = makeStereoWav(50);

    const paths = [
      path.join(tmpDir, "s1.wav"),
      path.join(tmpDir, "s2.wav"),
    ];
    fs.writeFileSync(paths[0], wav1);
    fs.writeFileSync(paths[1], wav2);

    const result = concatenateWavFiles(paths);
    const parsed = parseWav(result);

    expect(parsed.header.numChannels).toBe(2);
    expect(parsed.data.length).toBe(400); // 100 frames * 4 bytes
  });

  it("throws on empty file list", () => {
    expect(() => concatenateWavFiles([])).toThrow("No WAV files");
  });

  it("throws on format mismatch", () => {
    const mono = makeMonoWav(50);
    const stereo = makeStereoWav(50);

    const paths = [
      path.join(tmpDir, "mono.wav"),
      path.join(tmpDir, "stereo.wav"),
    ];
    fs.writeFileSync(paths[0], mono);
    fs.writeFileSync(paths[1], stereo);

    expect(() => concatenateWavFiles(paths)).toThrow("format mismatch");
  });

  it("single file returns equivalent WAV", () => {
    const wav = makeMonoWav(50);
    const p = path.join(tmpDir, "single.wav");
    fs.writeFileSync(p, wav);

    const result = concatenateWavFiles([p]);
    const original = parseWav(wav);
    const concat = parseWav(result);

    expect(concat.data).toEqual(original.data);
    expect(concat.header.numChannels).toBe(original.header.numChannels);
  });
});

// ---------------------------------------------------------------------------
// concatenateWavBuffers
// ---------------------------------------------------------------------------

describe("concatenateWavBuffers", () => {
  it("concatenates WAV buffers in memory", () => {
    const wav1 = makeMonoWav(50);
    const wav2 = makeMonoWav(50);

    const result = concatenateWavBuffers([wav1, wav2]);
    const parsed = parseWav(result);

    expect(parsed.data.length).toBe(200); // 100 frames * 2 bytes
  });

  it("throws on empty buffer list", () => {
    expect(() => concatenateWavBuffers([])).toThrow("No WAV buffers");
  });
});
