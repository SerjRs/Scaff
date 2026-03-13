import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobType } from "../types.js";

// --- Template tests (use real implementations, no mocks) ---

describe("Coding Executor Templates", () => {
  describe("Template Existence", () => {
    it("should load opus coding_run template", async () => {
      const { getTemplate } = await vi.importActual<typeof import("../templates/index.js")>("../templates/index.js");
      expect(() => getTemplate("opus", "coding_run")).not.toThrow();
    });

    it("should load sonnet coding_run template", async () => {
      const { getTemplate } = await vi.importActual<typeof import("../templates/index.js")>("../templates/index.js");
      expect(() => getTemplate("sonnet", "coding_run")).not.toThrow();
    });

    it("should load haiku coding_run template", async () => {
      const { getTemplate } = await vi.importActual<typeof import("../templates/index.js")>("../templates/index.js");
      expect(() => getTemplate("haiku", "coding_run")).not.toThrow();
    });
  });

  describe("Template Rendering", () => {
    it("should render opus coding_run template with task variable", async () => {
      const { getTemplate, renderTemplate } = await vi.importActual<typeof import("../templates/index.js")>("../templates/index.js");
      const template = getTemplate("opus", "coding_run");
      const rendered = renderTemplate(template, {
        task: "implement user auth",
        context: "",
        issuer: "",
        constraints: "",
      });

      expect(rendered).toContain("implement user auth");
      expect(rendered).not.toContain("{task}");
    });

    it("should render sonnet coding_run template with task variable", async () => {
      const { getTemplate, renderTemplate } = await vi.importActual<typeof import("../templates/index.js")>("../templates/index.js");
      const template = getTemplate("sonnet", "coding_run");
      const rendered = renderTemplate(template, {
        task: "fix database bug",
        context: "",
        issuer: "",
        constraints: "",
      });

      expect(rendered).toContain("fix database bug");
      expect(rendered).not.toContain("{task}");
    });

    it("should render haiku coding_run template with task variable", async () => {
      const { getTemplate, renderTemplate } = await vi.importActual<typeof import("../templates/index.js")>("../templates/index.js");
      const template = getTemplate("haiku", "coding_run");
      const rendered = renderTemplate(template, {
        task: "update readme",
        context: "",
        issuer: "",
        constraints: "",
      });

      expect(rendered).toContain("update readme");
      expect(rendered).not.toContain("{task}");
    });
  });

  describe("Template Content", () => {
    it("should contain claude CLI and exec/process keywords in opus template", async () => {
      const { getTemplate } = await vi.importActual<typeof import("../templates/index.js")>("../templates/index.js");
      const template = getTemplate("opus", "coding_run");
      const content = template.toLowerCase();

      expect(content).toContain("claude");
      expect(content).toContain("exec");
      expect(content).toContain("process");
    });

    it("should contain claude CLI keyword in sonnet template", async () => {
      const { getTemplate } = await vi.importActual<typeof import("../templates/index.js")>("../templates/index.js");
      const template = getTemplate("sonnet", "coding_run");
      const content = template.toLowerCase();

      expect(content).toContain("claude");
      expect(content).toContain("exec");
    });

    it("should contain appropriate executor instructions in haiku template", async () => {
      const { getTemplate } = await vi.importActual<typeof import("../templates/index.js")>("../templates/index.js");
      const template = getTemplate("haiku", "coding_run");
      const content = template.toLowerCase();

      expect(content).toContain("exec");
      expect(content).toContain("claude");
    });
  });
});

// --- Gateway Integration tests (use mocks) ---

describe("Gateway Integration with JobType", () => {
  vi.mock("../index.js", () => ({
    startRouter: vi.fn(),
  }));

  vi.mock("../evaluator.js", () => ({
    evaluate: vi.fn().mockResolvedValue({ weight: 5, reasoning: "test" }),
  }));

  vi.mock("../dispatcher.js", () => ({
    resolveWeightToTier: vi.fn().mockReturnValue("sonnet"),
    formatResourceBlocks: vi.fn().mockReturnValue(""),
  }));

  vi.mock("../templates/index.js", () => ({
    getTemplate: vi.fn().mockReturnValue("mock template {task}"),
    renderTemplate: vi.fn().mockReturnValue("rendered template"),
  }));

  vi.mock("../../gateway/call.js", () => ({
    callGateway: vi.fn().mockResolvedValue({ runId: "test-run-id" }),
  }));

  vi.mock("../queue.js", () => ({
    updateJob: vi.fn(),
    archiveJob: vi.fn(),
    initRouterDb: vi.fn().mockReturnValue({}),
  }));

  const mockInstance = {
    getConfig: vi.fn().mockReturnValue({
      evaluator: { model: "test", timeout: 30000, tier: "sonnet", fallback_weight: 5 },
      tiers: {
        haiku: { range: [1, 3], model: "haiku-model" },
        sonnet: { range: [4, 7], model: "sonnet-model" },
        opus: { range: [8, 10], model: "opus-model" },
      },
    }),
    enqueue: vi.fn().mockReturnValue("test-job-id"),
  };

  beforeEach(() => {
    (globalThis as any).__openclaw_router_instance__ = mockInstance;
  });

  it("should floor weight to 7 for coding_run jobs", async () => {
    const { evaluate } = await import("../evaluator.js");
    const { resolveWeightToTier } = await import("../dispatcher.js");

    (evaluate as any).mockResolvedValueOnce({ weight: 3, reasoning: "simple task" });
    (resolveWeightToTier as any).mockReturnValueOnce("opus");

    const opts = {
      method: "agent" as const,
      params: {
        message: "simple coding task",
        sessionKey: "test-session",
      },
      timeoutMs: 30000,
    };

    const { routerCallGateway } = await import("../gateway-integration.js");
    await routerCallGateway(opts, "sync", "coding_run" as JobType);

    expect(evaluate).toHaveBeenCalled();
    expect(resolveWeightToTier).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Object)
    );

    const [[actualWeight]] = (resolveWeightToTier as any).mock.calls;
    expect(actualWeight).toBeGreaterThanOrEqual(7);
  });

  it("should use agent_run jobType by default for backward compatibility", async () => {
    const { getTemplate } = await import("../templates/index.js");

    const opts = {
      method: "agent" as const,
      params: {
        message: "regular task",
        sessionKey: "test-session",
      },
      timeoutMs: 30000,
    };

    const { routerCallGateway } = await import("../gateway-integration.js");
    await routerCallGateway(opts, "sync");

    expect(getTemplate).toHaveBeenCalledWith("sonnet", "agent_run");
  });

  it("should use coding_run jobType when specified", async () => {
    const { getTemplate } = await import("../templates/index.js");

    const opts = {
      method: "agent" as const,
      params: {
        message: "coding task",
        sessionKey: "test-session",
      },
      timeoutMs: 30000,
    };

    const { routerCallGateway } = await import("../gateway-integration.js");
    await routerCallGateway(opts, "sync", "coding_run" as JobType);

    expect(getTemplate).toHaveBeenCalledWith("sonnet", "coding_run");
  });
});
