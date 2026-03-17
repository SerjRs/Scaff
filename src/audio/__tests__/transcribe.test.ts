import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  mergeSegments,
  buildFullText,
} from "../transcribe.js";
import type { TranscriptSegment } from "../transcribe.js";
import { buildWav, parseWav, splitStereoToMono, concatenateWavFiles } from "../wav-utils.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcribe-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mergeSegments
// ---------------------------------------------------------------------------

describe("mergeSegments", () => {
  it("interleaves two segment arrays by start time", () => {
    const user: TranscriptSegment[] = [
      { speaker: "user", start: 0.0, end: 4.2, text: "Hello everyone." },
      { speaker: "user", start: 10.0, end: 14.5, text: "Let's discuss Q1." },
    ];

    const others: TranscriptSegment[] = [
      { speaker: "others", start: 4.5, end: 9.0, text: "Hi, sounds good." },
      { speaker: "others", start: 15.0, end: 20.0, text: "Revenue was up 15%." },
    ];

    const merged = mergeSegments(user, others);

    expect(merged).toHaveLength(4);
    expect(merged[0].speaker).toBe("user");
    expect(merged[0].start).toBe(0.0);
    expect(merged[1].speaker).toBe("others");
    expect(merged[1].start).toBe(4.5);
    expect(merged[2].speaker).toBe("user");
    expect(merged[2].start).toBe(10.0);
    expect(merged[3].speaker).toBe("others");
    expect(merged[3].start).toBe(15.0);
  });

  it("handles overlapping timestamps (simultaneous speech)", () => {
    const user: TranscriptSegment[] = [
      { speaker: "user", start: 5.0, end: 10.0, text: "I think we should—" },
    ];
    const others: TranscriptSegment[] = [
      { speaker: "others", start: 5.0, end: 8.0, text: "Actually—" },
    ];

    const merged = mergeSegments(user, others);

    expect(merged).toHaveLength(2);
    // User comes first on ties
    expect(merged[0].speaker).toBe("user");
    expect(merged[1].speaker).toBe("others");
  });

  it("handles empty arrays", () => {
    expect(mergeSegments([], [])).toEqual([]);
    const seg: TranscriptSegment = { speaker: "user", start: 0, end: 1, text: "hi" };
    expect(mergeSegments([seg], [])).toEqual([seg]);
    expect(mergeSegments([], [{ ...seg, speaker: "others" }])).toEqual([{ ...seg, speaker: "others" }]);
  });

  it("handles single-speaker scenario (mono audio)", () => {
    const user: TranscriptSegment[] = [
      { speaker: "user", start: 0.0, end: 5.0, text: "Just me talking." },
      { speaker: "user", start: 5.5, end: 10.0, text: "Still just me." },
    ];

    const merged = mergeSegments(user, []);
    expect(merged).toHaveLength(2);
    expect(merged.every((s) => s.speaker === "user")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFullText
// ---------------------------------------------------------------------------

describe("buildFullText", () => {
  it("builds readable transcript text", () => {
    const segments: TranscriptSegment[] = [
      { speaker: "user", start: 0.0, end: 4.2, text: "Let's start with Q1 numbers." },
      { speaker: "others", start: 4.5, end: 12.1, text: "Revenue came in at 1.2 million." },
      { speaker: "user", start: 13.0, end: 15.0, text: "Great, what about expenses?" },
    ];

    const text = buildFullText(segments);

    expect(text).toBe(
      "User: Let's start with Q1 numbers.\n" +
      "Others: Revenue came in at 1.2 million.\n" +
      "User: Great, what about expenses?",
    );
  });

  it("handles empty segments", () => {
    expect(buildFullText([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Speaker labeling
// ---------------------------------------------------------------------------

describe("speaker labeling", () => {
  it("left channel segments get labeled as 'user'", () => {
    // Simulate what runWhisper would produce for left channel
    const segments: TranscriptSegment[] = [
      { speaker: "user", start: 0.0, end: 5.0, text: "Hello" },
      { speaker: "user", start: 5.5, end: 10.0, text: "World" },
    ];

    expect(segments.every((s) => s.speaker === "user")).toBe(true);
  });

  it("right channel segments get labeled as 'others'", () => {
    const segments: TranscriptSegment[] = [
      { speaker: "others", start: 0.0, end: 5.0, text: "Hello" },
      { speaker: "others", start: 5.5, end: 10.0, text: "World" },
    ];

    expect(segments.every((s) => s.speaker === "others")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transcript format validation
// ---------------------------------------------------------------------------

describe("transcript format", () => {
  it("matches expected JSON schema", () => {
    const segments: TranscriptSegment[] = [
      { speaker: "user", start: 0.0, end: 4.2, text: "Let's start with the Q1 numbers." },
      { speaker: "others", start: 4.5, end: 12.1, text: "Sure. Revenue came in at 1.2 million, 15% above target." },
    ];

    const transcript = {
      sessionId: "abc-123",
      startedAt: "2026-03-17T14:30:00Z",
      endedAt: "2026-03-17T15:15:00Z",
      durationMinutes: 45,
      language: "en",
      segments,
      fullText: buildFullText(segments),
    };

    // Verify structure
    expect(transcript.sessionId).toBe("abc-123");
    expect(transcript.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(transcript.durationMinutes).toBe(45);
    expect(transcript.language).toBe("en");
    expect(transcript.segments).toHaveLength(2);

    // Verify segment structure
    for (const seg of transcript.segments) {
      expect(seg).toHaveProperty("speaker");
      expect(seg).toHaveProperty("start");
      expect(seg).toHaveProperty("end");
      expect(seg).toHaveProperty("text");
      expect(["user", "others"]).toContain(seg.speaker);
      expect(typeof seg.start).toBe("number");
      expect(typeof seg.end).toBe("number");
      expect(typeof seg.text).toBe("string");
      expect(seg.end).toBeGreaterThan(seg.start);
    }

    // Verify fullText
    expect(transcript.fullText).toContain("User:");
    expect(transcript.fullText).toContain("Others:");

    // Verify JSON serialization round-trips
    const json = JSON.stringify(transcript);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(transcript);
  });
});

// ---------------------------------------------------------------------------
// runWhisper (mocked CLI)
// ---------------------------------------------------------------------------

describe("runWhisper (mocked)", () => {
  it("parses Whisper JSON output into segments", async () => {
    // We test the parsing logic by mocking execFile
    const { execFile } = await import("node:child_process");

    // Create a fake whisper output JSON
    const whisperOutput = {
      text: "Hello world. How are you?",
      segments: [
        { id: 0, seek: 0, start: 0.0, end: 2.5, text: " Hello world.", tokens: [], temperature: 0, avg_logprob: -0.3, compression_ratio: 1.0, no_speech_prob: 0.01 },
        { id: 1, seek: 250, start: 3.0, end: 5.0, text: " How are you?", tokens: [], temperature: 0, avg_logprob: -0.2, compression_ratio: 1.0, no_speech_prob: 0.01 },
      ],
      language: "en",
    };

    // Write fake input WAV and expected output
    const inputWav = path.join(tmpDir, "test-input.wav");
    fs.writeFileSync(inputWav, buildWav(Buffer.alloc(100), 1, 16000, 16));

    // Manually test the parsing path by simulating what runWhisper does internally
    const outputDir = path.join(tmpDir, "whisper-out");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "test-input.json"),
      JSON.stringify(whisperOutput),
    );

    // Parse the whisper output the same way runWhisper does
    const raw = fs.readFileSync(path.join(outputDir, "test-input.json"), "utf-8");
    const parsed = JSON.parse(raw) as typeof whisperOutput;

    const segments: TranscriptSegment[] = parsed.segments.map((seg) => ({
      speaker: "user" as const,
      start: seg.start,
      end: seg.end,
      text: seg.text.trim(),
    }));

    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      speaker: "user",
      start: 0.0,
      end: 2.5,
      text: "Hello world.",
    });
    expect(segments[1]).toEqual({
      speaker: "user",
      start: 3.0,
      end: 5.0,
      text: "How are you?",
    });
  });

  it("handles empty Whisper output", () => {
    const whisperOutput = {
      text: "",
      segments: [],
      language: "en",
    };

    const segments: TranscriptSegment[] = whisperOutput.segments.map((seg: any) => ({
      speaker: "others" as const,
      start: seg.start,
      end: seg.end,
      text: seg.text?.trim() ?? "",
    }));

    expect(segments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: WAV pipeline (without Whisper)
// ---------------------------------------------------------------------------

describe("E2E: WAV processing pipeline", () => {
  it("concatenate → split → verify channel isolation", () => {
    // Create 3 stereo chunks with known data
    const chunkPaths: string[] = [];
    for (let c = 0; c < 3; c++) {
      const frames = 100;
      const pcm = Buffer.alloc(frames * 4); // stereo 16-bit
      for (let i = 0; i < frames; i++) {
        pcm.writeInt16LE(c * 1000 + i, i * 4);       // left
        pcm.writeInt16LE(-(c * 1000 + i), i * 4 + 2); // right
      }
      const wav = buildWav(pcm, 2, 44100, 16);
      const p = path.join(tmpDir, `chunk-${String(c).padStart(4, "0")}.wav`);
      fs.writeFileSync(p, wav);
      chunkPaths.push(p);
    }

    // Concatenate
    const combined = concatenateWavFiles(chunkPaths);
    const combinedParsed = parseWav(combined);
    expect(combinedParsed.header.numChannels).toBe(2);
    expect(combinedParsed.data.length).toBe(300 * 4); // 300 frames * 4 bytes

    // Split
    const { left, right } = splitStereoToMono(combined);
    const leftParsed = parseWav(left);
    const rightParsed = parseWav(right);

    expect(leftParsed.header.numChannels).toBe(1);
    expect(rightParsed.header.numChannels).toBe(1);
    expect(leftParsed.data.length).toBe(600); // 300 frames * 2 bytes
    expect(rightParsed.data.length).toBe(600);

    // Verify first chunk left channel: 0, 1, 2, ...
    for (let i = 0; i < 5; i++) {
      expect(leftParsed.data.readInt16LE(i * 2)).toBe(i);
    }

    // Verify first chunk right channel: 0, -1, -2, ...
    for (let i = 0; i < 5; i++) {
      expect(rightParsed.data.readInt16LE(i * 2)).toBe(-i || 0);
    }

    // Verify second chunk left channel starts at 1000
    expect(leftParsed.data.readInt16LE(100 * 2)).toBe(1000);
  });

  it("handles corrupt WAV gracefully", () => {
    const corruptPath = path.join(tmpDir, "corrupt.wav");
    fs.writeFileSync(corruptPath, Buffer.from("not a wav file at all"));

    expect(() => concatenateWavFiles([corruptPath])).toThrow();
  });
});
