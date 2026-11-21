import type { AnalyzedNode, Hotspot, PlanAnalysis, RawPgExplainRoot, RawPgPlanNode } from "../types.js";

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function parseExplainJson(rawText: string): RawPgExplainRoot {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("Empty EXPLAIN JSON input.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Invalid EXPLAIN JSON: ${(err as Error).message}`);
  }
  const rootObj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!rootObj || typeof rootObj !== "object" || !("Plan" in rootObj)) {
    throw new Error('Expected PostgreSQL EXPLAIN (FORMAT JSON) object containing a "Plan" root node.');
  }
  const candidate = rootObj as RawPgExplainRoot;
  if (!candidate.Plan || typeof candidate.Plan !== "object" || typeof candidate.Plan["Node Type"] !== "string") {
    throw new Error('Invalid PostgreSQL Plan root: missing "Node Type".');
  }
  return candidate;
}

function buildLabel(node: RawPgPlanNode): string {
  const base = node["Node Type"];
  if (node["Index Name"] && node["Relation Name"]) {
    return `${base} on ${node["Relation Name"]} (${node["Index Name"]})`;
  }
  if (node["Relation Name"]) {
    return `${base} on ${node["Relation Name"]}`;
  }
  if (node["Join Type"]) {
    return `${node["Join Type"]} ${base}`;
  }
  return base;
}

function computeMisestimate(planRows: number, actualRows: number): number {
  const p = Math.max(1, planRows);
  const a = Math.max(1, actualRows);
  return Math.round(Math.max(a / p, p / a) * 10) / 10;
}

export function analyzeExplainPlan(raw: RawPgExplainRoot): PlanAnalysis {
  let nextId = 1;
  const allHotspots: Hotspot[] = [];
  let totalSharedHit = 0;
  let totalSharedRead = 0;
  let totalTempBlocks = 0;
  let nodeCount = 0;

  const rootTotalFallback = num(raw.Plan["Actual Total Time"]) * Math.max(1, num(raw.Plan["Actual Loops"], 1));
  const executionTimeMs = num(raw["Execution Time"], rootTotalFallback);
  const planningTimeMs = num(raw["Planning Time"], 0);
  const denomMs = Math.max(0.001, executionTimeMs > 0 ? executionTimeMs : rootTotalFallback);

  const visit = (node: RawPgPlanNode, depth: number, parentWorkers: number): AnalyzedNode => {
    const id = nextId++;
    nodeCount++;
    const loops = Math.max(1, num(node["Actual Loops"], 1));
    const workersLaunched = num(node["Workers Launched"], 0);
    const divisor = parentWorkers > 0 ? parentWorkers + 1 : 1;
    const inclusiveMs = Math.max(0, (num(node["Actual Total Time"]) * loops) / divisor);

    const childWorkers = workersLaunched > 0 ? workersLaunched : parentWorkers;
    const rawChildren = Array.isArray(node.Plans) ? node.Plans : [];
    const children = rawChildren.map((c) => visit(c, depth + 1, childWorkers));

    const childSumMs = children.reduce((acc, c) => acc + c.inclusiveMs, 0);
    const exclusiveMs = Math.max(0, Math.round((inclusiveMs - childSumMs) * 1000) / 1000);
    const roundedInclusive = Math.round(inclusiveMs * 1000) / 1000;

    // Buffer counts in Postgres EXPLAIN (ANALYZE, BUFFERS) are inclusive of children;
    // compute exclusive block counts per node for accurate hotspot attribution.
    const rawHit = num(node["Shared Hit Blocks"]);
    const rawRead = num(node["Shared Read Blocks"]);
    const rawTemp = num(node["Temp Read Blocks"]) + num(node["Temp Written Blocks"]);

    if (depth === 0) {
      totalSharedHit = rawHit;
      totalSharedRead = rawRead;
      totalTempBlocks = rawTemp;
    }

    const totalBuf = rawHit + rawRead;
    const bufferHitPct = totalBuf > 0 ? Math.round((rawHit / totalBuf) * 1000) / 10 : null;
    const planRows = num(node["Plan Rows"]);
    const actualRows = num(node["Actual Rows"]) * loops;
    const misestimateFactor = computeMisestimate(planRows, actualRows);
    const rowsRemovedByFilter = num(node["Rows Removed by Filter"]) * loops;
    const label = buildLabel(node);
    const percentOfTotal = Math.min(100, Math.round((exclusiveMs / denomMs) * 1000) / 10);

    const nodeHotspots: Hotspot[] = [];

    if (node["Node Type"] === "Seq Scan" && (actualRows >= 10_000 || percentOfTotal >= 15)) {
      nodeHotspots.push({
        kind: "LARGE_SEQ_SCAN",
        severity: actualRows >= 50_000 || percentOfTotal >= 35 ? "critical" : "warning",
        nodeId: id,
        nodeLabel: label,
        summary: `Seq Scan read ${actualRows.toLocaleString("en-US")} rows (${exclusiveMs.toFixed(1)} ms, ${percentOfTotal}% exclusive)`,
      });
    }

    if (misestimateFactor >= 10 && Math.max(planRows, actualRows) >= 1_000) {
      nodeHotspots.push({
        kind: "ROW_MISESTIMATE",
        severity: misestimateFactor >= 100 ? "critical" : "warning",
        nodeId: id,
        nodeLabel: label,
        summary: `Planner est ${planRows.toLocaleString("en-US")} vs actual ${actualRows.toLocaleString("en-US")} (${misestimateFactor.toLocaleString("en-US")}x misestimate)`,
      });
    }

    if (node["Sort Space Type"] === "Disk" || (rawTemp > 0 && children.every((c) => c.tempBlocks === 0))) {
      const kb = num(node["Sort Space Used"]);
      nodeHotspots.push({
        kind: "DISK_SPILL",
        severity: "critical",
        nodeId: id,
        nodeLabel: label,
        summary: kb > 0 ? `Spilled to disk (${kb.toLocaleString("en-US")} kB external sort)` : `Temp disk spill (${rawTemp} blocks)`,
      });
    }

    if (bufferHitPct !== null && bufferHitPct < 80 && rawRead >= 100 && children.length === 0) {
      nodeHotspots.push({
        kind: "LOW_BUFFER_HIT",
        severity: bufferHitPct < 50 ? "critical" : "warning",
        nodeId: id,
        nodeLabel: label,
        summary: `Low buffer cache hit ${bufferHitPct}% (${rawRead.toLocaleString("en-US")} shared blocks read from disk)`,
      });
    }

    if (rowsRemovedByFilter >= 5_000 && rowsRemovedByFilter > actualRows * 2) {
      nodeHotspots.push({
        kind: "HIGH_FILTER_REMOVAL",
        severity: "warning",
        nodeId: id,
        nodeLabel: label,
        summary: `Filter discarded ${rowsRemovedByFilter.toLocaleString("en-US")} rows to keep ${actualRows.toLocaleString("en-US")}`,
      });
    }

    allHotspots.push(...nodeHotspots);

    return {
      id,
      depth,
      nodeType: node["Node Type"],
      relation: node["Relation Name"],
      indexName: node["Index Name"],
      label,
      planRows,
      actualRows,
      actualLoops: loops,
      inclusiveMs: roundedInclusive,
      exclusiveMs,
      percentOfTotal,
      sharedHitBlocks: rawHit,
      sharedReadBlocks: rawRead,
      tempBlocks: rawTemp,
      bufferHitPct,
      misestimateFactor,
      rowsRemovedByFilter,
      sortSpaceType: node["Sort Space Type"],
      hotspots: nodeHotspots,
      children,
    };
  };

  const root = visit(raw.Plan, 0, 0);
  const overallBuf = totalSharedHit + totalSharedRead;
  const overallBufferHitPct = overallBuf > 0 ? Math.round((totalSharedHit / overallBuf) * 1000) / 10 : null;

  return {
    planningTimeMs: Math.round(planningTimeMs * 1000) / 1000,
    executionTimeMs: Math.round(executionTimeMs * 1000) / 1000,
    totalSharedHit,
    totalSharedRead,
    totalTempBlocks,
    overallBufferHitPct,
    nodeCount,
    root,
    hotspots: allHotspots,
  };
}
