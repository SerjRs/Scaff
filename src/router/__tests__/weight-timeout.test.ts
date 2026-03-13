import { describe, expect, it } from "vitest";
import { weightToTimeoutMs } from "../gateway-integration.js";
import { hungThresholdForWeight } from "../loop.js";

// ---------------------------------------------------------------------------
// weightToTimeoutMs
// ---------------------------------------------------------------------------

describe("weightToTimeoutMs", () => {
  it("weight 1 → 5min", () => {
    expect(weightToTimeoutMs(1)).toBe(5 * 60 * 1000);
  });

  it("weight 3 → 5min", () => {
    expect(weightToTimeoutMs(3)).toBe(5 * 60 * 1000);
  });

  it("weight 4 → 10min", () => {
    expect(weightToTimeoutMs(4)).toBe(10 * 60 * 1000);
  });

  it("weight 6 → 10min", () => {
    expect(weightToTimeoutMs(6)).toBe(10 * 60 * 1000);
  });

  it("weight 7 → 15min", () => {
    expect(weightToTimeoutMs(7)).toBe(15 * 60 * 1000);
  });

  it("weight 10 → 15min", () => {
    expect(weightToTimeoutMs(10)).toBe(15 * 60 * 1000);
  });

  it("weight 0 → 5min (edge: below range)", () => {
    expect(weightToTimeoutMs(0)).toBe(5 * 60 * 1000);
  });

  it("weight 11 → 15min (edge: above range)", () => {
    expect(weightToTimeoutMs(11)).toBe(15 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// hungThresholdForWeight
// ---------------------------------------------------------------------------

describe("hungThresholdForWeight", () => {
  it("weight 1 → 150s", () => {
    expect(hungThresholdForWeight(1)).toBe(150);
  });

  it("weight 3 → 150s", () => {
    expect(hungThresholdForWeight(3)).toBe(150);
  });

  it("weight 4 → 300s", () => {
    expect(hungThresholdForWeight(4)).toBe(300);
  });

  it("weight 6 → 300s", () => {
    expect(hungThresholdForWeight(6)).toBe(300);
  });

  it("weight 7 → 450s", () => {
    expect(hungThresholdForWeight(7)).toBe(450);
  });

  it("weight 10 → 450s", () => {
    expect(hungThresholdForWeight(10)).toBe(450);
  });

  it("null weight defaults to 5 → 300s", () => {
    expect(hungThresholdForWeight(null)).toBe(300);
  });
});
