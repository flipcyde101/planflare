import type { AnalyzedNode, Hotspot, PlanAnalysis, RawPgExplainRoot, RawPgPlanNode } from "../types.js";

const MAX_PLAN_DEPTH = 256;

function nonNegNum(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : fallback;
}

function unwrapPsqlJson(rawText: string): string {
  const lines = rawText.replace(/\r\n/g, "\n").split("\n");
  const cleaned: string[] = [];
  let skippingHeader = true;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (skippingHeader) {
      if (
        !trimmed ||
        trimmed === "QUERY PLAN" ||
        /^-+$/.test(trimmed) ||
        /^[-+]+$/.test(trimmed)
      ) {
        continue;
      }
      skippingHeader = false;
    }

    if (/^\(\d+\s+rows?\)$/i.test(trimmed) || /^Time:\s+[\d.,]+\s+ms/i.test(trimmed)) {
      break;
    }

    // Strip psql wrapped-line continuation marker (`+` at end of line, with or without preceding spaces)
    const unwrapped = rawLine.replace(/\s*\+\s*$/, "");
    cleaned.push(unwrapped);
  }

  return cleaned.join("\n").trim();
}

function validatePlanNode(node: unknown, depth: number, seen: WeakSet<object>): RawPgPlanNode {
  if (depth > MAX_PLAN_DEPTH) {
    throw new Error(`PostgreSQL plan exceeds maximum nesting depth of ${MAX_PLAN_DEPTH}.`);
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new Error("Invalid PostgreSQL plan node: expected an object.");
  }
  if (seen.has(node)) {
    throw new Error("Invalid PostgreSQL plan: circular reference detected in Plans.");
  }
  seen.add(node);

  const rec = node as Record<string, unknown>;
  if (typeof rec["Node Type"] !== "string" || !rec["Node Type"].trim()) {
    throw new Error('Invalid PostgreSQL plan node: missing non-empty "Node Type".');
  }

  if (rec.Plans !== undefined) {
    if (!Array.isArray(rec.Plans)) {
      throw new Error('Invalid PostgreSQL plan node: "Plans" must be an array.');
    }
    for (const child of rec.Plans) {
      validatePlanNode(child, depth + 1, seen);
    }
  }

  return node as RawPgPlanNode;
}

function assertHasAnalyzeMetrics(root: RawPgExplainRoot): void {
  const plan = root.Plan;
  const hasActualTime = typeof plan["Actual Total Time"] === "number" && Number.isFinite(plan["Actual Total Time"]);
  const hasActualLoops = typeof plan["Actual Loops"] === "number" && Number.isFinite(plan["Actual Loops"]);
  const hasExecTime = typeof root["Execution Time"] === "number" && Number.isFinite(root["Execution Time"]);
  if (!hasActualTime && !hasActualLoops && !hasExecTime) {
    throw new Error(
      'Input looks like EXPLAIN without ANALYZE (missing "Actual Total Time", "Actual Loops", and "Execution Time"). Re-run with EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON).'
    );
  }
}

export function parseExplainJson(rawText: string): RawPgExplainRoot {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("Empty EXPLAIN JSON input.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (firstErr) {
    const unwrapped = unwrapPsqlJson(trimmed);
    if (!unwrapped || unwrapped === trimmed) {
      throw new Error(`Invalid EXPLAIN JSON: ${(firstErr as Error).message}`);
    }
    try {
      parsed = JSON.parse(unwrapped);
    } catch {
      throw new Error(`Invalid EXPLAIN JSON: ${(firstErr as Error).message}`);
    }
  }
  const rootObj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!rootObj || typeof rootObj !== "object" || Array.isArray(rootObj) || !("Plan" in rootObj)) {
    throw new Error('Expected PostgreSQL EXPLAIN (FORMAT JSON) object containing a "Plan" root node.');
  }
  const candidate = rootObj as RawPgExplainRoot;
  validatePlanNode(candidate.Plan, 0, new WeakSet<object>());
  assertHasAnalyzeMetrics(candidate);
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

function computeMisestimate(planRows: number, actualRowsPerLoop: number): number {
  const p = Math.max(1, planRows);
  const a = Math.max(1, actualRowsPerLoop);
  return Math.round(Math.max(a / p, p / a) * 10) / 10;
}

interface VisitResult {
  analyzed: AnalyzedNode;
  rawHit: number;
  rawRead: number;
  rawTemp: number;
  isInitPlan: boolean;
}

export function analyzeExplainPlan(raw: RawPgExplainRoot): PlanAnalysis {
  if (!raw || typeof raw !== "object" || !("Plan" in raw)) {
    throw new Error('Expected PostgreSQL EXPLAIN (FORMAT JSON) object containing a "Plan" root node.');
  }
  validatePlanNode(raw.Plan, 0, new WeakSet<object>());
  assertHasAnalyzeMetrics(raw);

  let nextId = 1;
  const allHotspots: Hotspot[] = [];
  let totalSharedHit = 0;
  let totalSharedRead = 0;
  let totalTempBlocks = 0;
  let nodeCount = 0;

  const rootLoopsRaw = raw.Plan["Actual Loops"];
  const rootLoops = typeof rootLoopsRaw === "number" && Number.isFinite(rootLoopsRaw) ? Math.max(0, rootLoopsRaw) : 1;
  const rootTotalFallback = nonNegNum(raw.Plan["Actual Total Time"]) * rootLoops;
  const executionTimeMs = nonNegNum(raw["Execution Time"], rootTotalFallback);
  const planningTimeMs = nonNegNum(raw["Planning Time"], 0);
  const denomMs = Math.max(0.001, executionTimeMs > 0 ? executionTimeMs : rootTotalFallback);

  const visit = (node: RawPgPlanNode, depth: number, parentWorkers: number): VisitResult => {
    const id = nextId++;
    nodeCount++;
    const isInitPlan = node["Parent Relationship"] === "InitPlan";
    const effectiveParentWorkers = isInitPlan || node["Single Copy"] === true ? 0 : parentWorkers;

    const rawLoopsVal = node["Actual Loops"];
    const neverExecuted = typeof rawLoopsVal === "number" && Number.isFinite(rawLoopsVal) && rawLoopsVal <= 0;
    const loops = neverExecuted ? 0 : typeof rawLoopsVal === "number" && Number.isFinite(rawLoopsVal) ? rawLoopsVal : 1;

    const workersLaunched = nonNegNum(node["Workers Launched"], 0);
    const divisor = effectiveParentWorkers > 0 ? Math.max(1, Math.min(loops, effectiveParentWorkers + 1)) : 1;
    const inclusiveMs = neverExecuted ? 0 : (nonNegNum(node["Actual Total Time"]) * loops) / divisor;

    const childWorkers = node["Single Copy"] === true
      ? 0
      : workersLaunched > 0
        ? workersLaunched
        : effectiveParentWorkers;

    const rawChildren = Array.isArray(node.Plans) ? node.Plans : [];
    const childResults = rawChildren.map((c) => visit(c, depth + 1, childWorkers));
    const children = childResults.map((r) => r.analyzed);

    const childSumMs = childResults
      .filter((r) => !r.isInitPlan)
      .reduce((acc, r) => acc + r.analyzed.inclusiveMs, 0);
    const exclusiveMs = neverExecuted ? 0 : Math.max(0, Math.round((inclusiveMs - childSumMs) * 1000) / 1000);
    const roundedInclusive = Math.round(inclusiveMs * 1000) / 1000;

    // Buffer counts in Postgres EXPLAIN (ANALYZE, BUFFERS) are inclusive of children;
    // subtract direct child raw counts to compute true exclusive blocks per node.
    const rawHit = nonNegNum(node["Shared Hit Blocks"]);
    const rawRead = nonNegNum(node["Shared Read Blocks"]);
    const rawTemp = nonNegNum(node["Temp Read Blocks"]) + nonNegNum(node["Temp Written Blocks"]);

    const childHitSum = childResults.reduce((acc, r) => acc + r.rawHit, 0);
    const childReadSum = childResults.reduce((acc, r) => acc + r.rawRead, 0);
    const childTempSum = childResults.reduce((acc, r) => acc + r.rawTemp, 0);

    const exclusiveHit = Math.max(0, rawHit - childHitSum);
    const exclusiveRead = Math.max(0, rawRead - childReadSum);
    const exclusiveTemp = Math.max(0, rawTemp - childTempSum);

    if (depth === 0) {
      totalSharedHit = rawHit;
      totalSharedRead = rawRead;
      totalTempBlocks = rawTemp;
    }

    const totalBuf = rawHit + rawRead;
    const bufferHitPct = totalBuf > 0 ? Math.round((rawHit / totalBuf) * 1000) / 10 : null;
    const exclusiveBuf = exclusiveHit + exclusiveRead;
    const exclusiveBufHitPct = exclusiveBuf > 0 ? Math.round((exclusiveHit / exclusiveBuf) * 1000) / 10 : null;

    const planRows = nonNegNum(node["Plan Rows"]);
    const actualRowsPerLoop = neverExecuted ? 0 : nonNegNum(node["Actual Rows"]);
    const actualRows = actualRowsPerLoop * loops;
    const misestimateFactor = neverExecuted ? 1 : computeMisestimate(planRows, actualRowsPerLoop);
    const rowsRemovedByFilter = neverExecuted ? 0 : nonNegNum(node["Rows Removed by Filter"]) * loops;
    const label = buildLabel(node);
    const percentOfTotal = neverExecuted ? 0 : Math.min(100, Math.round((exclusiveMs / denomMs) * 1000) / 10);

    const nodeHotspots: Hotspot[] = [];

    if (!neverExecuted) {
      if (node["Node Type"] === "Seq Scan" && (actualRows >= 10_000 || percentOfTotal >= 15)) {
        nodeHotspots.push({
          kind: "LARGE_SEQ_SCAN",
          severity: actualRows >= 50_000 || percentOfTotal >= 35 ? "critical" : "warning",
          nodeId: id,
          nodeLabel: label,
          summary: `Seq Scan read ${actualRows.toLocaleString("en-US")} rows (${exclusiveMs.toFixed(1)} ms, ${percentOfTotal}% exclusive)`,
        });
      }

      if (misestimateFactor >= 10 && Math.max(planRows, actualRowsPerLoop) >= 1_000) {
        nodeHotspots.push({
          kind: "ROW_MISESTIMATE",
          severity: misestimateFactor >= 100 ? "critical" : "warning",
          nodeId: id,
          nodeLabel: label,
          summary: `Planner est ${planRows.toLocaleString("en-US")} vs actual ${actualRowsPerLoop.toLocaleString("en-US")} rows/loop (${misestimateFactor.toLocaleString("en-US")}x misestimate)`,
        });
      }

      if (node["Sort Space Type"] === "Disk" || exclusiveTemp > 0) {
        const kb = nonNegNum(node["Sort Space Used"]);
        nodeHotspots.push({
          kind: "DISK_SPILL",
          severity: "critical",
          nodeId: id,
          nodeLabel: label,
          summary: kb > 0 ? `Spilled to disk (${kb.toLocaleString("en-US")} kB external sort)` : `Temp disk spill (${exclusiveTemp} exclusive blocks)`,
        });
      }

      if (exclusiveBufHitPct !== null && exclusiveBufHitPct < 80 && exclusiveRead >= 100) {
        nodeHotspots.push({
          kind: "LOW_BUFFER_HIT",
          severity: exclusiveBufHitPct < 50 ? "critical" : "warning",
          nodeId: id,
          nodeLabel: label,
          summary: `Low buffer cache hit ${exclusiveBufHitPct}% (${exclusiveRead.toLocaleString("en-US")} exclusive shared blocks read from disk)`,
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
    }

    allHotspots.push(...nodeHotspots);

    return {
      analyzed: {
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
      },
      rawHit,
      rawRead,
      rawTemp,
      isInitPlan,
    };
  };

  const root = visit(raw.Plan, 0, 0).analyzed;
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
