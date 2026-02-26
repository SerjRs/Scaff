import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearTemplateCache, getTemplate, renderTemplate } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  clearTemplateCache();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// getTemplate
// ---------------------------------------------------------------------------

describe("getTemplate", () => {
  it("loads the haiku/agent_run template", () => {
    const tpl = getTemplate("haiku", "agent_run");
    expect(tpl).toBeTruthy();
    expect(tpl).toContain("{task}");
    expect(tpl).toContain("task executor");
    expect(tpl).toContain("no tools");
  });

  it("loads the sonnet/agent_run template", () => {
    const tpl = getTemplate("sonnet", "agent_run");
    expect(tpl).toBeTruthy();
    expect(tpl).toContain("{task}");
    expect(tpl).toContain("task executor");
    expect(tpl).toContain("no tools");
  });

  it("loads the opus/agent_run template", () => {
    const tpl = getTemplate("opus", "agent_run");
    expect(tpl).toBeTruthy();
    expect(tpl).toContain("{task}");
    expect(tpl).toContain("task executor");
    expect(tpl).toContain("no tools");
  });

  it("throws a clear error for invalid tier/type", () => {
    expect(() => getTemplate("haiku" as any, "nonexistent" as any)).toThrow(
      /Template not found.*haiku\/nonexistent/,
    );
  });

  it("throws a clear error for completely invalid tier", () => {
    expect(() => getTemplate("mythic" as any, "agent_run")).toThrow(
      /Template not found.*mythic\/agent_run/,
    );
  });

  it("caches templates — second call does not re-read from disk", () => {
    const readFileSpy = vi.spyOn(fs, "readFileSync");

    const first = getTemplate("haiku", "agent_run");
    expect(readFileSpy).toHaveBeenCalledTimes(1);

    const second = getTemplate("haiku", "agent_run");
    // Still only 1 call — served from cache
    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("returns the exact file contents", () => {
    const expected = fs.readFileSync(
      path.join(__dirname, "haiku", "agent_run.md"),
      "utf-8",
    );
    const tpl = getTemplate("haiku", "agent_run");
    expect(tpl).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// renderTemplate
// ---------------------------------------------------------------------------

describe("renderTemplate", () => {
  it("replaces all known variables", () => {
    const template = "Task: {task}. Context: {context}. By: {issuer}. Rules: {constraints}";
    const result = renderTemplate(template, {
      task: "summarize the doc",
      context: "a 3-page PDF",
      issuer: "session:abc",
      constraints: "max 100 words",
    });

    expect(result).toBe(
      "Task: summarize the doc. Context: a 3-page PDF. By: session:abc. Rules: max 100 words",
    );
  });

  it("leaves unknown variables as-is (no crash)", () => {
    const template = "Hello {name}, your {role} is ready. Also {unknown}.";
    const result = renderTemplate(template, { name: "Alice", role: "admin" });
    expect(result).toBe("Hello Alice, your admin is ready. Also {unknown}.");
  });

  it("handles missing variables gracefully — leaves {var} in place", () => {
    const template = "{task} with {context}";
    const result = renderTemplate(template, {});
    expect(result).toBe("{task} with {context}");
  });

  it("replaces multiple occurrences of the same variable", () => {
    const template = "{x} and {x} again";
    const result = renderTemplate(template, { x: "hello" });
    expect(result).toBe("hello and hello again");
  });

  it("handles empty template", () => {
    expect(renderTemplate("", { task: "x" })).toBe("");
  });

  it("handles template with no placeholders", () => {
    const plain = "No variables here.";
    expect(renderTemplate(plain, { task: "x" })).toBe(plain);
  });

  it("works end-to-end with a real template", () => {
    const tpl = getTemplate("haiku", "agent_run");
    const rendered = renderTemplate(tpl, {
      task: "count to 10",
    });

    expect(rendered).not.toContain("{task}");
    expect(rendered).toContain("count to 10");
    expect(rendered).toContain("task executor");
  });
});
