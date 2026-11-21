import type { Hotspot, PlanAnalysis, PlanDiffResult } from "../types.js";

function hotspotKey(h: Hotspot): string {
  return `${h.kind}::${h.nodeLabel}`;
}

export function diffPlans(before: PlanAnalysis, after: PlanAnalysis): PlanDiffResult {
  const beforeMs = before.executionTimeMs;
  const afterMs = after.executionTimeMs;
  const deltaMs = Math.round((afterMs - beforeMs) * 1000) / 1000;
  const deltaPct =
    beforeMs > 0
      ? Math.round(((afterMs - beforeMs) / beforeMs) * 1000) / 10
      : afterMs === 0
        ? 0
        : null;

  const afterCounts = new Map<string, number>();
  for (const h of after.hotspots) {
    const k = hotspotKey(h);
    afterCounts.set(k, (afterCounts.get(k) ?? 0) + 1);
  }

  const resolvedHotspots: Hotspot[] = [];
  const beforeRemaining = new Map<string, number>();
  for (const h of before.hotspots) {
    const k = hotspotKey(h);
    const avail = afterCounts.get(k) ?? 0;
    if (avail > 0) {
      afterCounts.set(k, avail - 1);
      beforeRemaining.set(k, (beforeRemaining.get(k) ?? 0) + 1);
    } else {
      resolvedHotspots.push(h);
    }
  }

  const newHotspots: Hotspot[] = [];
  const remainingHotspots: Hotspot[] = [];
  for (const h of after.hotspots) {
    const k = hotspotKey(h);
    const matched = beforeRemaining.get(k) ?? 0;
    if (matched > 0) {
      beforeRemaining.set(k, matched - 1);
      remainingHotspots.push(h);
    } else {
      newHotspots.push(h);
    }
  }

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
    newHotspots,
    remainingHotspots,
    before,
    after,
  };
}
