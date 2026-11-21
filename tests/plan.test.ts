import { describe, it, expect } from "vitest";
import { analyzeExplainPlan, parseExplainJson } from "../src/analyze/plan.js";
import { DEMO_AFTER_PLAN, DEMO_BEFORE_PLAN } from "../src/demo/fixture.js";

describe("PostgreSQL EXPLAIN ANALYZE parser & hotspot engine", () => {
  it("parses array-wrapped and single-object EXPLAIN JSON and rejects malformed input", () => {
    const arr = parseExplainJson(JSON.stringify([DEMO_BEFORE_PLAN]));
    expect(arr.Plan["Node Type"]).toBe("Limit");
    expect(parseExplainJson(JSON.stringify(DEMO_AFTER_PLAN)).Plan["Node Type"]).toBe("Limit");
    expect(() => parseExplainJson("")).toThrow();
    expect(() => parseExplainJson("{}")).toThrow(/Plan/);
  });

  it("computes exclusive vs inclusive timings, buffer hit %, and all 5 hotspot badges accurately", () => {
    const before = analyzeExplainPlan(DEMO_BEFORE_PLAN);
    expect(before.executionTimeMs).toBe(1840.2);
    expect(before.nodeCount).toBe(3);
    expect(before.hotspots.some((h) => h.kind === "LARGE_SEQ_SCAN")).toBe(true);
    expect(before.hotspots.some((h) => h.kind === "ROW_MISESTIMATE")).toBe(true);
    expect(before.hotspots.some((h) => h.kind === "DISK_SPILL")).toBe(true);
    expect(before.hotspots.some((h) => h.kind === "LOW_BUFFER_HIT")).toBe(true);
    expect(before.hotspots.some((h) => h.kind === "HIGH_FILTER_REMOVAL")).toBe(true);

    // Exclusive time of Sort = 1839.6 - 1284.4 = 555.2 ms
    const sortNode = before.root.children[0];
    expect(sortNode.exclusiveMs).toBeCloseTo(555.2, 1);

    const after = analyzeExplainPlan(DEMO_AFTER_PLAN);
    expect(after.hotspots).toHaveLength(0);
    expect(after.overallBufferHitPct).toBeGreaterThan(99);
  });
});
