import { describe, it, expect } from "vitest";
import { diffPlans } from "../src/analyze/diff.js";
import { analyzeExplainPlan } from "../src/analyze/plan.js";
import { DEMO_AFTER_PLAN, DEMO_BEFORE_PLAN } from "../src/demo/fixture.js";

describe("side-by-side plan diff engine", () => {
  it("computes latency reduction, block read delta, and resolved hotspots", () => {
    const diff = diffPlans(analyzeExplainPlan(DEMO_BEFORE_PLAN), analyzeExplainPlan(DEMO_AFTER_PLAN));
    expect(diff.beforeMs).toBe(1840.2);
    expect(diff.afterMs).toBe(4.2);
    expect(diff.deltaPct).toBe(-99.8);
    expect(diff.resolvedHotspots.length).toBeGreaterThanOrEqual(4);
    expect(diff.remainingHotspots).toHaveLength(0);
  });
});
