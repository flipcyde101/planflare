import { describe, it, expect } from "vitest";
import { diffPlans } from "../src/analyze/diff.js";
import { analyzeExplainPlan } from "../src/analyze/plan.js";
import { DEMO_AFTER_PLAN, DEMO_BEFORE_PLAN } from "../src/demo/fixture.js";
import { formatHtmlFlamegraph, formatMarkdownDiff, formatTerminalDiff, formatTerminalFlamegraph } from "../src/render/format.js";

describe("planflare formatters (terminal, Markdown PR, standalone HTML)", () => {
  it("renders flamegraph, diff, Markdown PR table, and XSS-safe HTML", () => {
    const before = analyzeExplainPlan(DEMO_BEFORE_PLAN);
    const diff = diffPlans(before, analyzeExplainPlan(DEMO_AFTER_PLAN));

    const term = formatTerminalFlamegraph(before);
    expect(term).toContain("LARGE_SEQ_SCAN");
    expect(term).toContain("7,017.5x");

    const diffTerm = formatTerminalDiff(diff);
    expect(diffTerm).toContain("1840.20 ms -> 4.20 ms (-99.8%)");

    const md = formatMarkdownDiff(diff);
    expect(md).toContain("| **Execution Time** |");
    expect(md).toContain("planflare");

    const html = formatHtmlFlamegraph(before, "Query </script><img src=x>");
    expect(html).not.toContain("</script><img");
    expect(html).toContain("&lt;/script&gt;");
  });
});
