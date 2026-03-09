import { describe, it, expect } from "vitest";

// We test the exported functions by importing the source directly.
// contextToMessages and consolidateMessages are not exported, so we
// test through a wrapper that exercises the same logic.

// Since the functions are not exported, we replicate the core logic
// here for unit testing. These tests validate:
// 1. toolCall → tool_use normalization
// 2. thinking block stripping
// 3. tool_use/tool_result pairing validation
// 4. consolidation doesn't break tool pairing

// ---------- Helpers (replicated from llm-caller.ts) ----------

type AnthropicMessage = { role: "user" | "assistant"; content: string | unknown[] };

function normalizeBlocks(content: string): string | unknown[] {
  if (typeof content === "string" && content.startsWith("[")) {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const normalized = parsed.map((block: any) => {
          if (block.type === "toolCall") {
            return { type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} };
          }
          if (block.type === "thinking" || block.type === "thinkingSignature" || block.type === "redactedThinking") {
            return null;
          }
          return block;
        }).filter(Boolean);
        if (normalized.length === 0) return "(internal processing)";
        return normalized;
      }
    } catch { /* keep as string */ }
  }
  return content;
}

function consolidateMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return [];
  const consolidated: AnthropicMessage[] = [{ ...messages[0] }];
  for (let i = 1; i < messages.length; i++) {
    const prev = consolidated[consolidated.length - 1];
    if (messages[i].role === prev.role) {
      const prevBlocks = Array.isArray(prev.content) ? prev.content
        : [{ type: "text" as const, text: prev.content }];
      const nextBlocks = Array.isArray(messages[i].content) ? messages[i].content
        : [{ type: "text" as const, text: messages[i].content }];
      prev.content = [...prevBlocks, ...(nextBlocks as unknown[])];
    } else {
      consolidated.push({ ...messages[i] });
    }
  }
  return consolidated;
}

function validateToolPairing(messages: AnthropicMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!Array.isArray(msg.content)) continue;

    if (msg.role === "user") {
      const validIds = new Set<string>();
      if (i > 0 && messages[i - 1].role === "assistant") {
        const prev = messages[i - 1].content;
        if (Array.isArray(prev)) {
          for (const block of prev as any[]) {
            if (block.type === "tool_use" && block.id) {
              validIds.add(block.id);
            }
          }
        }
      }
      msg.content = (msg.content as any[]).map((block: any) => {
        if (block.type === "tool_result") {
          if (!block.tool_use_id || !validIds.has(block.tool_use_id)) {
            const summary = typeof block.content === "string"
              ? block.content.substring(0, 200)
              : JSON.stringify(block.content ?? "").substring(0, 200);
            return { type: "text", text: `[Tool result: ${summary}]` };
          }
        }
        return block;
      });
    }

    if (msg.role === "assistant") {
      msg.content = (msg.content as any[]).map((block: any) => {
        if (block.type === "tool_use") {
          if (!block.id || !block.name) {
            return { type: "text", text: `[Tool call: ${block.name ?? "unknown"}]` };
          }
          if (typeof block.input !== "object" || block.input === null) {
            block.input = {};
          }
        }
        return block;
      });

      // Check that every tool_use has a matching tool_result in the next user message
      if (i + 1 < messages.length && messages[i + 1].role === "user") {
        const nextContent = messages[i + 1].content;
        const resultIds = new Set<string>();
        if (Array.isArray(nextContent)) {
          for (const block of nextContent as any[]) {
            if (block.type === "tool_result" && block.tool_use_id) {
              resultIds.add(block.tool_use_id);
            }
          }
        }
        msg.content = (msg.content as any[]).map((block: any) => {
          if (block.type === "tool_use" && !resultIds.has(block.id)) {
            return { type: "text", text: `[Tool call: ${block.name}(${block.id})]` };
          }
          return block;
        });
      }
    }
  }
}

// ---------- Tests ----------

describe("normalizeBlocks", () => {
  it("converts toolCall to tool_use", () => {
    const input = JSON.stringify([
      { type: "toolCall", id: "toolu_123", name: "sessions_spawn", arguments: { task: "test" } },
    ]);
    const result = normalizeBlocks(input);
    expect(result).toEqual([
      { type: "tool_use", id: "toolu_123", name: "sessions_spawn", input: { task: "test" } },
    ]);
  });

  it("strips thinking blocks", () => {
    const input = JSON.stringify([
      { type: "thinking", thinking: "some internal thought" },
      { type: "text", text: "visible response" },
    ]);
    const result = normalizeBlocks(input);
    expect(result).toEqual([{ type: "text", text: "visible response" }]);
  });

  it("returns placeholder when all blocks are thinking", () => {
    const input = JSON.stringify([
      { type: "thinking", thinking: "thought" },
      { type: "thinkingSignature", signature: "abc" },
    ]);
    const result = normalizeBlocks(input);
    expect(result).toBe("(internal processing)");
  });

  it("preserves regular text content", () => {
    expect(normalizeBlocks("hello")).toBe("hello");
  });

  it("preserves tool_use blocks (already correct format)", () => {
    const input = JSON.stringify([
      { type: "tool_use", id: "toolu_456", name: "web_search", input: { query: "test" } },
    ]);
    const result = normalizeBlocks(input);
    expect(result).toEqual([
      { type: "tool_use", id: "toolu_456", name: "web_search", input: { query: "test" } },
    ]);
  });

  it("handles malformed JSON gracefully", () => {
    expect(normalizeBlocks("[invalid json")).toBe("[invalid json");
  });

  it("handles toolCall with no arguments", () => {
    const input = JSON.stringify([
      { type: "toolCall", id: "toolu_789", name: "get_status" },
    ]);
    const result = normalizeBlocks(input);
    expect(result).toEqual([
      { type: "tool_use", id: "toolu_789", name: "get_status", input: {} },
    ]);
  });
});

describe("consolidateMessages", () => {
  it("merges consecutive same-role messages", () => {
    const msgs: AnthropicMessage[] = [
      { role: "user", content: "hello" },
      { role: "user", content: "world" },
    ];
    const result = consolidateMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
  });

  it("preserves alternating roles", () => {
    const msgs: AnthropicMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "user", content: "q2" },
    ];
    const result = consolidateMessages(msgs);
    expect(result).toHaveLength(3);
  });

  it("merges tool_result blocks into consolidated user message", () => {
    const msgs: AnthropicMessage[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "result2" }] },
    ];
    const result = consolidateMessages(msgs);
    expect(result).toHaveLength(1);
    expect((result[0].content as any[]).length).toBe(2);
  });
});

describe("validateToolPairing", () => {
  it("keeps valid tool_result with matching tool_use", () => {
    const msgs: AnthropicMessage[] = [
      { role: "assistant", content: [
        { type: "tool_use", id: "toolu_abc", name: "web_search", input: { q: "test" } },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_abc", content: "search results" },
      ]},
    ];
    validateToolPairing(msgs);
    expect((msgs[1].content as any[])[0].type).toBe("tool_result");
    expect((msgs[1].content as any[])[0].tool_use_id).toBe("toolu_abc");
  });

  it("converts orphaned tool_result to text", () => {
    const msgs: AnthropicMessage[] = [
      { role: "assistant", content: "just text, no tool_use" },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_orphan", content: "some result" },
      ]},
    ];
    validateToolPairing(msgs);
    expect((msgs[1].content as any[])[0].type).toBe("text");
    expect((msgs[1].content as any[])[0].text).toContain("Tool result:");
  });

  it("converts tool_result with missing tool_use_id to text", () => {
    const msgs: AnthropicMessage[] = [
      { role: "assistant", content: [
        { type: "tool_use", id: "toolu_xyz", name: "read", input: {} },
      ]},
      { role: "user", content: [
        { type: "tool_result", content: "result without id" },
      ]},
    ];
    validateToolPairing(msgs);
    expect((msgs[1].content as any[])[0].type).toBe("text");
  });

  it("converts tool_result referencing wrong tool_use_id to text", () => {
    const msgs: AnthropicMessage[] = [
      { role: "assistant", content: [
        { type: "tool_use", id: "toolu_aaa", name: "read", input: {} },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_bbb", content: "wrong ref" },
      ]},
    ];
    validateToolPairing(msgs);
    expect((msgs[1].content as any[])[0].type).toBe("text");
    expect((msgs[1].content as any[])[0].text).toContain("Tool result:");
  });

  it("handles multiple tool_use/tool_result pairs correctly", () => {
    const msgs: AnthropicMessage[] = [
      { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "search", input: {} },
        { type: "tool_use", id: "t2", name: "read", input: {} },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: "r1" },
        { type: "tool_result", tool_use_id: "t2", content: "r2" },
        { type: "tool_result", tool_use_id: "t3", content: "orphan" },
      ]},
    ];
    validateToolPairing(msgs);
    const blocks = msgs[1].content as any[];
    expect(blocks[0].type).toBe("tool_result");
    expect(blocks[1].type).toBe("tool_result");
    expect(blocks[2].type).toBe("text"); // orphaned t3
  });

  it("converts tool_use with missing id to text", () => {
    const msgs: AnthropicMessage[] = [
      { role: "assistant", content: [
        { type: "tool_use", name: "search", input: {} },
      ]},
    ];
    validateToolPairing(msgs);
    expect((msgs[0].content as any[])[0].type).toBe("text");
    expect((msgs[0].content as any[])[0].text).toContain("Tool call:");
  });

  it("ensures tool_use input is always an object", () => {
    const msgs: AnthropicMessage[] = [
      { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "search", input: null },
      ]},
    ];
    validateToolPairing(msgs);
    expect((msgs[0].content as any[])[0].input).toEqual({});
  });

  it("converts orphaned tool_use (no matching tool_result) to text", () => {
    const msgs: AnthropicMessage[] = [
      { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "search", input: {} },
        { type: "tool_use", id: "t2", name: "read", input: {} },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: "result1" },
        // t2 has no matching tool_result
      ]},
    ];
    validateToolPairing(msgs);
    const assistantBlocks = msgs[0].content as any[];
    expect(assistantBlocks[0].type).toBe("tool_use"); // t1 kept
    expect(assistantBlocks[1].type).toBe("text"); // t2 converted
    expect(assistantBlocks[1].text).toContain("read");
  });

  it("handles user message with no preceding assistant (first message)", () => {
    const msgs: AnthropicMessage[] = [
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: "orphan" },
      ]},
    ];
    validateToolPairing(msgs);
    expect((msgs[0].content as any[])[0].type).toBe("text");
  });
});

describe("full pipeline: normalize + consolidate + validate", () => {
  it("handles the exact corruption case from production", () => {
    // Simulate: assistant sends toolCall JSON, multiple user tool_results follow,
    // consolidation merges them, then a new assistant text follows with another
    // user tool_result that references a different tool_use_id
    const raw = [
      { role: "assistant" as const, content: JSON.stringify([
        { type: "toolCall", id: "toolu_A", name: "sessions_spawn", arguments: { task: "task1" } },
        { type: "toolCall", id: "toolu_B", name: "sessions_spawn", arguments: { task: "task2" } },
      ])},
      { role: "user" as const, content: JSON.stringify([
        { type: "tool_result", tool_use_id: "toolu_A", content: "done1" },
      ])},
      { role: "user" as const, content: JSON.stringify([
        { type: "tool_result", tool_use_id: "toolu_B", content: "done2" },
      ])},
      { role: "user" as const, content: "What happened with the tasks?" },
      { role: "assistant" as const, content: "Both tasks completed." },
      { role: "user" as const, content: JSON.stringify([
        { type: "tool_result", tool_use_id: "toolu_C", content: "orphaned result" },
      ])},
    ];

    // Step 1: Normalize
    const normalized: AnthropicMessage[] = raw.map(m => ({
      role: m.role,
      content: normalizeBlocks(m.content),
    }));

    // toolCall should be converted to tool_use
    expect((normalized[0].content as any[])[0].type).toBe("tool_use");

    // Step 2: Consolidate
    const consolidated = consolidateMessages(normalized);

    // Step 3: Validate
    validateToolPairing(consolidated);

    // Verify no tool_result references a missing tool_use
    for (let i = 0; i < consolidated.length; i++) {
      const msg = consolidated[i];
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content as any[]) {
        // No tool_result should remain with an invalid reference
        if (block.type === "tool_result") {
          // If it survived validation, its tool_use_id must be in the preceding assistant msg
          const prev = i > 0 ? consolidated[i - 1] : null;
          if (prev && Array.isArray(prev.content)) {
            const ids = (prev.content as any[]).filter(b => b.type === "tool_use").map(b => b.id);
            expect(ids).toContain(block.tool_use_id);
          }
        }
      }
    }

    // The orphaned toolu_C should have been converted to text
    const lastUser = consolidated[consolidated.length - 1];
    if (Array.isArray(lastUser.content)) {
      const hasOrphanedToolResult = (lastUser.content as any[]).some(
        (b: any) => b.type === "tool_result" && b.tool_use_id === "toolu_C"
      );
      expect(hasOrphanedToolResult).toBe(false);
    }
  });
});
