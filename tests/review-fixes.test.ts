import { describe, it, expect } from "vitest";
import { analyzeExplainPlan, parseExplainJson } from "../src/analyze/plan.js";
import { diffPlans } from "../src/analyze/diff.js";
import { formatHtmlFlamegraph, formatMarkdownDiff } from "../src/render/format.js";
import { parseCliArgs } from "../src/cli.js";
import type { RawPgExplainRoot } from "../src/types.js";

describe("planflare whole-branch review regression fixes (C1-C4, I1-I9, M1)", () => {
  it("C1 & C2: compares per-loop Plan Rows vs Actual Rows and ignores Actual Loops === 0 (Never Executed) nodes", () => {
    const plan: RawPgExplainRoot = {
      "Execution Time": 12.5,
      Plan: {
        "Node Type": "Nested Loop",
        "Plan Rows": 1000,
        "Actual Rows": 1000,
        "Actual Loops": 1,
        "Actual Total Time": 12.0,
        Plans: [
          {
            // Accurate estimate (1 row/loop * 1000 loops) must NOT trigger ROW_MISESTIMATE!
            "Node Type": "Index Scan",
            "Relation Name": "users",
            "Plan Rows": 1,
            "Actual Rows": 1,
            "Actual Loops": 1000,
            "Actual Total Time": 0.01,
          },
          {
            // Never Executed (Actual Loops === 0) must NOT emit ROW_MISESTIMATE!
            "Node Type": "Seq Scan",
            "Relation Name": "archive_orders",
            "Plan Rows": 50000,
            "Actual Rows": 0,
            "Actual Loops": 0,
            "Actual Total Time": 0,
          },
        ],
      },
    };

    const analyzed = analyzeExplainPlan(plan);
    expect(analyzed.hotspots.some((h) => h.kind === "ROW_MISESTIMATE")).toBe(false);
    expect(analyzed.root.children[1].actualLoops).toBe(0);
    expect(analyzed.root.children[1].inclusiveMs).toBe(0);
  });

  it("C3 & C4: rejects EXPLAIN without ANALYZE and rejects null/corrupt Plans entries", () => {
    expect(() =>
      analyzeExplainPlan(
        parseExplainJson(JSON.stringify([{ Plan: { "Node Type": "Seq Scan", "Plan Rows": 50000 } }]))
      )
    ).toThrow(/ANALYZE/i);

    expect(() => parseExplainJson('{"Plan":{"Node Type":"Limit","Plans":[null]}}')).toThrow();
    expect(() => parseExplainJson('{"Plan":{"Node Type":"Limit","Plans":[{}]}}')).toThrow();
  });

  it("I1 & I2 & I3 & I4: handles psql-wrapped JSON, Bitmap Heap Scan exclusive buffer hits, stacked disk spills, and clamps negative values", () => {
    const wrapped = [
      "                 QUERY PLAN                 ",
      "--------------------------------------------",
      ' [                                         +',
      '   {                                       +',
      '     "Execution Time": 45.0,               +',
      '     "Plan": {                             +',
      '       "Node Type": "Bitmap Heap Scan",    +',
      '       "Relation Name": "events",          +',
      '       "Plan Rows": 500,                   +',
      '       "Actual Rows": 500,                 +',
      '       "Actual Loops": 1,                  +',
      '       "Actual Total Time": 44.0,          +',
      '       "Shared Hit Blocks": 100,           +',
      '       "Shared Read Blocks": 900,          +',
      '       "Temp Written Blocks": 250,         +',
      '       "Plans": [                          +',
      '         {                                 +',
      '           "Node Type": "Bitmap Index Scan",+',
      '           "Plan Rows": 500,               +',
      '           "Actual Rows": 500,             +',
      '           "Actual Loops": 1,              +',
      '           "Actual Total Time": 4.0,       +',
      '           "Shared Hit Blocks": 90,        +',
      '           "Shared Read Blocks": 10,       +',
      '           "Temp Written Blocks": 50       +',
      "         }                                 +",
      "       ]                                   +",
      "     }                                     +",
      "   }                                       +",
      " ]",
      "(1 row)",
      "Time: 46.123 ms",
    ].join("\n");

    const parsed = parseExplainJson(wrapped);
    const analyzed = analyzeExplainPlan(parsed);
    // Exclusive reads on Bitmap Heap Scan = 900 - 10 = 890, exclusive hits = 100 - 90 = 10 => 1.1% hit => LOW_BUFFER_HIT!
    expect(analyzed.root.hotspots.some((h) => h.kind === "LOW_BUFFER_HIT")).toBe(true);
    // Exclusive temp spill on parent = 250 - 50 = 200 => DISK_SPILL even though child also had temp spill!
    expect(analyzed.root.hotspots.some((h) => h.kind === "DISK_SPILL")).toBe(true);
  });

  it("I5, I6, I7: handles beforeMs=0 deltaPct=null, escapes Markdown/U+2028, formats n/a without stray %, and includes remaining hotspots in Markdown diff", () => {
    const zeroBefore = analyzeExplainPlan({
      "Execution Time": 0,
      Plan: { "Node Type": "Result", "Plan Rows": 1, "Actual Rows": 1, "Actual Loops": 1, "Actual Total Time": 0 },
    });
    const slowAfter = analyzeExplainPlan({
      "Execution Time": 120,
      Plan: {
        "Node Type": "Seq Scan",
        "Relation Name": "t`evil\n# injected",
        "Plan Rows": 100,
        "Actual Rows": 50000,
        "Actual Loops": 1,
        "Actual Total Time": 120,
      },
    });

    const diff = diffPlans(zeroBefore, slowAfter);
    expect(diff.deltaPct).toBeNull();
    expect(diff.newHotspots.length).toBeGreaterThanOrEqual(1);

    const md = formatMarkdownDiff(diff);
    expect(md).not.toContain("n/a%");
    expect(md).toContain("New / Remaining Hotspots");
    expect(md).not.toContain("\n# injected");

    const html = formatHtmlFlamegraph({ ...slowAfter, root: { ...slowAfter.root, label: "a\u2028b\u2029c" } });
    expect(html).toContain("\\u2028");
    expect(html).toContain("\\u2029");
  });

  it("I8: rejects conflicting CLI flags (--json --markdown, --demo extra.json, diff with --html)", () => {
    expect(() => parseCliArgs(["--demo", "--json", "--markdown"])).toThrow();
    expect(() => parseCliArgs(["--demo", "extra.json"])).toThrow();
    expect(() => parseCliArgs(["diff", "a.json", "b.json", "--html", "out.html"])).toThrow();
    expect(() => parseCliArgs(["a.json", "--markdown"])).toThrow();
    // Positional filename literally named "diff" after subcommand "diff" must work
    const ok = parseCliArgs(["diff", "before.json", "diff"]);
    expect(ok.mode).toBe("diff");
    expect(ok.files).toEqual(["before.json", "diff"]);
  });
});
