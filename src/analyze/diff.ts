import type { PlanAnalysis, PlanDiffResult } from "../types.js";

export function diffPlans(before: PlanAnalysis, after: PlanAnalysis): PlanDiffResult {
  const beforeMs = before.executionTimeMs;
  const afterMs = after.executionTimeMs;
  const deltaMs = Math.round((afterMs - beforeMs) * 1000) / 1000;
  const deltaPct = beforeMs > 0 ? Math.round(((afterMs - beforeMs) / beforeMs) * 1000) / 10 : 0;

  const afterKeys = new Set(after.hotspots.map((h) => `${h.kind}::${h.nodeLabel}`));
  const resolvedHotspots = before.hotspots.filter((h) => !afterKeys.has(`${h.kind}::${h.nodeLabel}`));

  return {
    beforeMs,
    afterMs,
    deltaMs,
    deltaPct,
    beforeSharedRead: before.totalSharedRead,
    afterSharedRead: after.totalSharedRead,
    beforeTempBlocks: before.totalTempBlocks,
    afterTempBlocks: after.totalTempBlocks,
    resolvedHotspots,
    remainingHotspots: after.hotspots,
    before,
    after,
  };
}
