import type { AnalyzedNode, PlanAnalysis, PlanDiffResult } from "../types.js";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeMdInline(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/`/g, "'").replace(/\|/g, "\\|");
}

function formatPct(pct: number | null): string {
  if (pct === null) return "n/a";
  return `${pct}%`;
}

function formatDeltaPct(deltaPct: number | null): string {
  if (deltaPct === null) return "n/a";
  const sign = deltaPct > 0 ? "+" : "";
  return `${sign}${deltaPct}%`;
}

function renderBar(pct: number, width = 22): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function formatTerminalFlamegraph(analysis: PlanAnalysis): string {
  const bufStr = formatPct(analysis.overallBufferHitPct);
  const lines: string[] = [
    `planflare · Exec: ${analysis.executionTimeMs.toFixed(2)} ms · Plan: ${analysis.planningTimeMs.toFixed(2)} ms · Buffer Hit: ${bufStr} · Nodes: ${analysis.nodeCount}`,
    `Hotspots: ${analysis.hotspots.length}`,
    "",
  ];

  const walk = (node: AnalyzedNode): void => {
    const indent = "  ".repeat(Math.min(node.depth, 20));
    const bar = renderBar(node.percentOfTotal, 18);
    const badge = node.hotspots.length > 0 ? ` [${node.hotspots.map((h) => h.kind).join(", ")}]` : "";
    lines.push(
      `${indent}${bar} ${node.percentOfTotal.toFixed(1).padStart(5)}% (${node.exclusiveMs.toFixed(1)}ms self / ${node.inclusiveMs.toFixed(1)}ms incl) ${node.label} (est=${node.planRows} act=${node.actualRows})${badge}`
    );
    for (const c of node.children) walk(c);
  };

  walk(analysis.root);

  if (analysis.hotspots.length > 0) {
    lines.push("", "Detected Hotspots:");
    for (const h of analysis.hotspots) {
      lines.push(`  [${h.severity.toUpperCase()} ${h.kind}] ${h.nodeLabel}: ${h.summary}`);
    }
  }

  return lines.join("\n");
}

export function formatTerminalDiff(diff: PlanDiffResult): string {
  const lines: string[] = [
    `planflare diff · ${diff.beforeMs.toFixed(2)} ms -> ${diff.afterMs.toFixed(2)} ms (${formatDeltaPct(diff.deltaPct)})`,
    `Shared Reads: ${diff.beforeSharedRead.toLocaleString("en-US")} -> ${diff.afterSharedRead.toLocaleString("en-US")} blocks | Temp Spill: ${diff.beforeTempBlocks} -> ${diff.afterTempBlocks} blocks`,
    `Hotspots: ${diff.before.hotspots.length} -> ${diff.after.hotspots.length} (${diff.resolvedHotspots.length} resolved, ${diff.newHotspots.length} new)`,
  ];

  if (diff.resolvedHotspots.length > 0) {
    lines.push("", "Resolved Hotspots:");
    for (const h of diff.resolvedHotspots) {
      lines.push(`  - RESOLVED [${h.kind}] ${h.nodeLabel}: ${h.summary}`);
    }
  }

  if (diff.newHotspots.length > 0) {
    lines.push("", "New Hotspots:");
    for (const h of diff.newHotspots) {
      lines.push(`  - NEW [${h.kind}] ${h.nodeLabel}: ${h.summary}`);
    }
  }

  if (diff.remainingHotspots.length > 0) {
    lines.push("", "Remaining Hotspots:");
    for (const h of diff.remainingHotspots) {
      lines.push(`  - OPEN [${h.kind}] ${h.nodeLabel}: ${h.summary}`);
    }
  }

  return lines.join("\n");
}

export function formatMarkdownDiff(diff: PlanDiffResult): string {
  const lines: string[] = [
    `### planflare Query Plan Diff (${diff.beforeMs.toFixed(1)} ms -> ${diff.afterMs.toFixed(1)} ms, ${formatDeltaPct(diff.deltaPct)})`,
    "",
    "| Metric | Before | After |",
    "|---|---:|---:|",
    `| **Execution Time** | ${diff.beforeMs.toFixed(2)} ms | ${diff.afterMs.toFixed(2)} ms |`,
    `| **Shared Blocks Read** | ${diff.beforeSharedRead.toLocaleString("en-US")} | ${diff.afterSharedRead.toLocaleString("en-US")} |`,
    `| **Temp Spill Blocks** | ${diff.beforeTempBlocks.toLocaleString("en-US")} | ${diff.afterTempBlocks.toLocaleString("en-US")} |`,
    `| **Buffer Hit %** | ${formatPct(diff.before.overallBufferHitPct)} | ${formatPct(diff.after.overallBufferHitPct)} |`,
    `| **Hotspots** | ${diff.before.hotspots.length} | ${diff.after.hotspots.length} |`,
    "",
  ];

  if (diff.resolvedHotspots.length > 0) {
    lines.push("**Resolved Hotspots:**");
    for (const h of diff.resolvedHotspots) {
      lines.push(`- \`${h.kind}\` on \`${escapeMdInline(h.nodeLabel)}\`: ${escapeMdInline(h.summary)}`);
    }
    lines.push("");
  }

  const openHotspots = [...diff.newHotspots, ...diff.remainingHotspots];
  if (openHotspots.length > 0) {
    lines.push("**New / Remaining Hotspots:**");
    for (const h of diff.newHotspots) {
      lines.push(`- [NEW] \`${h.kind}\` on \`${escapeMdInline(h.nodeLabel)}\`: ${escapeMdInline(h.summary)}`);
    }
    for (const h of diff.remainingHotspots) {
      lines.push(`- [OPEN] \`${h.kind}\` on \`${escapeMdInline(h.nodeLabel)}\`: ${escapeMdInline(h.summary)}`);
    }
    lines.push("");
  }

  lines.push("_Generated offline with [planflare](https://github.com/flipcyde101/planflare)_");
  return lines.join("\n");
}

export function formatHtmlFlamegraph(analysis: PlanAnalysis, title = "PostgreSQL EXPLAIN ANALYZE Flamegraph"): string {
  const payload = safeJson(analysis);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)} | planflare</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    body { margin: 0; padding: 24px; background: #0d1117; color: #e6edf3; }
    h1 { margin: 0 0 8px 0; font-size: 20px; color: #58a6ff; }
    .meta { color: #8b949e; font-size: 13px; margin-bottom: 18px; }
    .node { margin: 6px 0; padding: 8px 12px; border-radius: 8px; background: #161b22; border: 1px solid #30363d; }
    .node.hot { border-color: #f85149; background: #1c1012; }
    .bar-wrap { height: 8px; background: #21262d; border-radius: 999px; overflow: hidden; margin-top: 6px; }
    .bar-fill { height: 100%; background: linear-gradient(90deg, #f97316, #ef4444); }
    .badge { display: inline-block; margin-left: 8px; padding: 1px 6px; border-radius: 999px; font-size: 11px; background: #f8514922; color: #ffa198; border: 1px solid #f85149; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">Execution: ${analysis.executionTimeMs.toFixed(2)} ms | Planning: ${analysis.planningTimeMs.toFixed(2)} ms | Hotspots: ${analysis.hotspots.length}</div>
  <div id="tree"></div>
  <script>
    const DATA = ${payload};
    const rootEl = document.getElementById("tree");
    function renderNode(n) {
      const el = document.createElement("div");
      el.className = n.hotspots.length > 0 ? "node hot" : "node";
      el.style.marginLeft = (Math.min(n.depth, 20) * 16) + "px";
      const top = document.createElement("div");
      top.textContent = n.label + " | " + n.exclusiveMs.toFixed(1) + " ms self (" + n.percentOfTotal + "%) | est=" + n.planRows + " act=" + n.actualRows;
      for (const h of n.hotspots) {
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = h.kind;
        top.appendChild(b);
      }
      const bw = document.createElement("div");
      bw.className = "bar-wrap";
      const bf = document.createElement("div");
      bf.className = "bar-fill";
      bf.style.width = (n.percentOfTotal > 0 ? Math.max(2, n.percentOfTotal) : 0) + "%";
      bw.appendChild(bf);
      el.append(top, bw);
      rootEl.appendChild(el);
      for (const c of n.children || []) renderNode(c);
    }
    renderNode(DATA.root);
  </script>
</body>
</html>`;
}
