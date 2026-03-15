import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Verify that the Library section in the system prompt has been updated
 * to reference Knowledge Graph instead of breadcrumbs, while keeping
 * library tool guidance intact.
 *
 * Instead of calling contextToMessages (which requires runtime dependencies),
 * we read the source of llm-caller.ts and check the string constants directly.
 * This is robust — the prompt text is built from string concatenation literals.
 */

const llmCallerSource = fs.readFileSync(
  path.resolve(__dirname, "../llm-caller.ts"),
  "utf-8",
);

describe("Library breadcrumbs removed from system prompt", () => {
  it("does NOT mention breadcrumbs", () => {
    // Extract the ## Library section from the source
    const librarySection = llmCallerSource.slice(
      llmCallerSource.indexOf('"## Library'),
      llmCallerSource.indexOf('"## Library') + 2000,
    );
    expect(librarySection.toLowerCase()).not.toContain("breadcrumb");
  });

  it("mentions Knowledge Graph and sourced_from", () => {
    expect(llmCallerSource).toContain("Knowledge Graph");
    expect(llmCallerSource).toContain("sourced_from");
  });

  it("still mentions library_get", () => {
    const librarySection = llmCallerSource.slice(
      llmCallerSource.indexOf('"## Library'),
    );
    expect(librarySection).toContain("library_get");
  });

  it("still mentions library_search", () => {
    const librarySection = llmCallerSource.slice(
      llmCallerSource.indexOf('"## Library'),
    );
    expect(librarySection).toContain("library_search");
  });

  it("still mentions library_ingest", () => {
    const librarySection = llmCallerSource.slice(
      llmCallerSource.indexOf('"## Library'),
    );
    expect(librarySection).toContain("library_ingest");
  });

  it("mentions graph_traverse for exploring domain knowledge", () => {
    const librarySection = llmCallerSource.slice(
      llmCallerSource.indexOf('"## Library'),
    );
    expect(librarySection).toContain("graph_traverse");
  });
});

describe("Library breadcrumb injection removed from context.ts", () => {
  const contextSource = fs.readFileSync(
    path.resolve(__dirname, "../context.ts"),
    "utf-8",
  );

  it("does not contain Library breadcrumb injection block", () => {
    expect(contextSource).not.toContain("Library breadcrumbs");
    expect(contextSource).not.toContain("getBreadcrumbs");
    expect(contextSource).not.toContain("formatBreadcrumbs");
    expect(contextSource).not.toContain("generateEmbedding");
  });

  it("does not import from library/retrieval or library/embeddings", () => {
    expect(contextSource).not.toContain("../library/retrieval");
    expect(contextSource).not.toContain("../library/embeddings");
  });
});
