import type { RawPgExplainRoot } from "../types.js";

export const DEMO_BEFORE_PLAN: RawPgExplainRoot = {
  "Planning Time": 1.42,
  "Execution Time": 1840.2,
  Plan: {
    "Node Type": "Limit",
    "Plan Rows": 50,
    "Actual Rows": 50,
    "Actual Loops": 1,
    "Actual Total Time": 1839.8,
    "Shared Hit Blocks": 1842,
    "Shared Read Blocks": 42190,
    "Temp Read Blocks": 4820,
    "Temp Written Blocks": 4824,
    Plans: [
      {
        "Node Type": "Sort",
        "Sort Space Type": "Disk",
        "Sort Space Used": 38560,
        "Plan Rows": 120,
        "Actual Rows": 50,
        "Actual Loops": 1,
        "Actual Total Time": 1839.6,
        "Shared Hit Blocks": 1842,
        "Shared Read Blocks": 42190,
        "Temp Read Blocks": 4820,
        "Temp Written Blocks": 4824,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "orders",
            "Plan Rows": 120,
            "Actual Rows": 842100,
            "Actual Loops": 1,
            "Actual Total Time": 1284.4,
            "Rows Removed by Filter": 2140900,
            "Shared Hit Blocks": 1842,
            "Shared Read Blocks": 42190,
            Filter: "(tenant_id = 42 AND status = 'paid')",
          },
        ],
      },
    ],
  },
};

export const DEMO_AFTER_PLAN: RawPgExplainRoot = {
  "Planning Time": 0.48,
  "Execution Time": 4.2,
  Plan: {
    "Node Type": "Limit",
    "Plan Rows": 50,
    "Actual Rows": 50,
    "Actual Loops": 1,
    "Actual Total Time": 4.1,
    "Shared Hit Blocks": 318,
    "Shared Read Blocks": 2,
    "Temp Read Blocks": 0,
    "Temp Written Blocks": 0,
    Plans: [
      {
        "Node Type": "Index Scan",
        "Relation Name": "orders",
        "Index Name": "idx_orders_tenant_status_created",
        "Plan Rows": 52,
        "Actual Rows": 50,
        "Actual Loops": 1,
        "Actual Total Time": 3.9,
        "Shared Hit Blocks": 318,
        "Shared Read Blocks": 2,
        "Index Cond": "(tenant_id = 42 AND status = 'paid')",
      },
    ],
  },
};
