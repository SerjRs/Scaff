import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";
import { redactConfigSnapshot } from "./redact-snapshot.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

describe("audioCapture config schema", () => {
  it("accepts full audioCapture config", () => {
    const res = validateConfigObject({
      audioCapture: {
        enabled: true,
        apiKey: "cortex-audio-2026-a7f3b9e1",
        maxChunkSizeMB: 15,
        dataDir: "data/audio",
        port: 9100,
        whisperBinary: "whisper",
        whisperModel: "base.en",
        whisperLanguage: "en",
        whisperThreads: 4,
        retentionDays: 30,
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts partial audioCapture config (only enabled + apiKey)", () => {
    const res = validateConfigObject({
      audioCapture: {
        enabled: true,
        apiKey: "x",
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts config without audioCapture key", () => {
    const res = validateConfigObject({});

    expect(res.ok).toBe(true);
  });

  it("rejects unknown key inside audioCapture (.strict())", () => {
    const res = validateConfigObject({
      audioCapture: {
        enabled: true,
        unknownField: true,
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => /unrecognized/i.test(i.message))).toBe(true);
    }
  });

  it("rejects wrong type for maxChunkSizeMB", () => {
    const res = validateConfigObject({
      audioCapture: {
        maxChunkSizeMB: "fifteen",
      },
    });

    expect(res.ok).toBe(false);
  });

  it("redacts apiKey in config snapshot", () => {
    const config = {
      audioCapture: {
        enabled: true,
        apiKey: "super-secret-audio-key",
      },
    };
    const snapshot: ConfigFileSnapshot = {
      path: "/home/user/.openclaw/config.json5",
      exists: true,
      raw: JSON.stringify(config),
      parsed: config,
      resolved: config as ConfigFileSnapshot["resolved"],
      valid: true,
      config: config as ConfigFileSnapshot["config"],
      hash: "abc123",
      issues: [],
      warnings: [],
      legacyIssues: [],
    } as unknown as ConfigFileSnapshot;

    const redacted = redactConfigSnapshot(snapshot);
    const ac = (redacted.config as Record<string, Record<string, unknown>>).audioCapture;
    expect(ac.apiKey).not.toBe("super-secret-audio-key");
    expect(ac.enabled).toBe(true);
  });
});
