/**
 * Transcript Librarian prompt builder tests.
 *
 * Verifies buildLibrarianPrompt() produces correct guidance for audio-capture://
 * URLs (transcript-specific: action items, decisions, participants) vs regular URLs.
 *
 * Does NOT test the onIngest callback wiring — see whisper-e2e.test.ts test 4
 * and real-e2e.test.ts Suite 2 for that.
 */

import { describe, it, expect } from "vitest";
import { buildLibrarianPrompt } from "../../library/librarian-prompt.js";

// ---------------------------------------------------------------------------
// Test: buildLibrarianPrompt with audio-capture:// URL
// ---------------------------------------------------------------------------

describe("buildLibrarianPrompt — transcript awareness", () => {
  it("includes transcript-specific guidance for audio-capture:// URLs", () => {
    const prompt = buildLibrarianPrompt("audio-capture://session-123", "Hello world meeting notes");
    expect(prompt).toContain("audio-capture://session-123");
    expect(prompt).toContain("transcript");
    expect(prompt).toContain("action items");
    expect(prompt).toContain("decisions");
    expect(prompt).toContain("participants");
    expect(prompt).toContain("deadlines");
    // content_type enum should include transcript
    expect(prompt).toContain("transcript");
  });

  it("does NOT include transcript guidance for regular URLs", () => {
    const prompt = buildLibrarianPrompt("https://example.com/article", "Some article content");
    expect(prompt).not.toContain("meeting transcript");
    expect(prompt).not.toContain("action items");
  });
});

// ---------------------------------------------------------------------------
// Test: prompt content verification
// ---------------------------------------------------------------------------

describe("buildLibrarianPrompt — content", () => {
  it("prompt contains the full text and session URL", () => {
    const sessionId = "test-session-abc";
    const fullText = "This is a test transcript with important meeting content.";
    const prompt = buildLibrarianPrompt(`audio-capture://${sessionId}`, fullText);

    expect(prompt).toContain(`audio-capture://${sessionId}`);
    expect(prompt).toContain(fullText);
    expect(prompt).toContain("Librarian");
  });

  it("preserves content within 50K", () => {
    const text = "Meeting notes ".repeat(100);
    const prompt = buildLibrarianPrompt("audio-capture://sess-1", text);
    expect(prompt).toContain(text);
  });
});
