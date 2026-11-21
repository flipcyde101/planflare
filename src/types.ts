export type HotspotKind =
  | "LARGE_SEQ_SCAN"
  | "ROW_MISESTIMATE"
  | "DISK_SPILL"
  | "LOW_BUFFER_HIT"
  | "HIGH_FILTER_REMOVAL";

export interface RawPgPlanNode {
  "Node Type": string;
  "Parent Relationship"?: string;
  "Single Copy"?: boolean;
  "Relation Name"?: string;
  "Index Name"?: string;
  Alias?: string;
  "Join Type"?: string;
  "Startup Cost"?: number;
  "Total Cost"?: number;
  "Plan Rows"?: number;
  "Actual Startup Time"?: number;
  "Actual Total Time"?: number;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Workers Planned"?: number;
  "Workers Launched"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Shared Dirtied Blocks"?: number;
  "Shared Written Blocks"?: number;
  "Temp Read Blocks"?: number;
  "Temp Written Blocks"?: number;
  "Sort Space Type"?: string;
  "Sort Space Used"?: number;
  "Rows Removed by Filter"?: number;
  Filter?: string;
  "Index Cond"?: string;
  Plans?: RawPgPlanNode[];
}

export interface RawPgExplainRoot {
  Plan: RawPgPlanNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
}

export interface Hotspot {
  kind: HotspotKind;
  severity: "critical" | "warning";
  nodeId: number;
  nodeLabel: string;
  summary: string;
}

export interface AnalyzedNode {
  id: number;
  depth: number;
  nodeType: string;
  relation?: string;
  indexName?: string;
  label: string;
  planRows: number;
  actualRows: number;
  actualLoops: number;
  inclusiveMs: number;
  exclusiveMs: number;
  percentOfTotal: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
  tempBlocks: number;
  bufferHitPct: number | null;
  misestimateFactor: number;
  rowsRemovedByFilter: number;
  sortSpaceType?: string;
  hotspots: Hotspot[];
  children: AnalyzedNode[];
}

export interface PlanAnalysis {
  planningTimeMs: number;
  executionTimeMs: number;
  totalSharedHit: number;
  totalSharedRead: number;
  totalTempBlocks: number;
  overallBufferHitPct: number | null;
  nodeCount: number;
  root: AnalyzedNode;
  hotspots: Hotspot[];
}

export interface PlanDiffResult {
  beforeMs: number;
  afterMs: number;
  deltaMs: number;
  deltaPct: number | null;
  beforeSharedRead: number;
  afterSharedRead: number;
  beforeTempBlocks: number;
  afterTempBlocks: number;
  resolvedHotspots: Hotspot[];
  newHotspots: Hotspot[];
  remainingHotspots: Hotspot[];
  before: PlanAnalysis;
  after: PlanAnalysis;
}
