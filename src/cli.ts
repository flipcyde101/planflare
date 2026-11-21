import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffPlans } from "./analyze/diff.js";
import { analyzeExplainPlan, parseExplainJson } from "./analyze/plan.js";
import { DEMO_AFTER_PLAN, DEMO_BEFORE_PLAN } from "./demo/fixture.js";
import { formatHtmlFlamegraph, formatMarkdownDiff, formatTerminalDiff, formatTerminalFlamegraph } from "./render/format.js";

export interface ParsedCliArgs {
  mode: "help" | "analyze" | "diff" | "demo";
  files: string[];
  json: boolean;
  markdown: boolean;
  htmlOut?: string;
}

function printHelp(): void {
  console.log(`planflare v0.1.0 - Offline PostgreSQL EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) flamegraph & plan diff CLI

Usage:
  psql -XAtc "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ..." | planflare
  planflare <plan.json> [options]                    Analyze a saved EXPLAIN JSON file
  planflare diff <before.json> <after.json> [opts]   Diff two plans side by side
  planflare --demo [options]                         Run offline demo (1,840.2 ms -> 4.2 ms index fix)

Options:
  --markdown                                         Output Markdown PR summary (for diff / --demo)
  --html <file.html>                                 Write standalone offline HTML flamegraph
  --json                                             Output machine-readable JSON
  -h, --help                                         Show this help`);
}

function requireVal(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined || !v.trim() || v.trim().startsWith("-")) {
    throw new Error(`Missing or empty value for ${flag}`);
  }
  return v.trim();
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    mode: "analyze",
    files: [],
    json: false,
    markdown: false,
  };

  let explicitMode: ParsedCliArgs["mode"] | null = null;
  const setMode = (m: ParsedCliArgs["mode"]) => {
    if (explicitMode && explicitMode !== m) {
      throw new Error(`Conflicting modes "${explicitMode}" and "${m}"`);
    }
    explicitMode = m;
    parsed.mode = m;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      parsed.mode = "help";
      return parsed;
    } else if (arg === "--demo") {
      setMode("demo");
    } else if (arg === "diff") {
      setMode("diff");
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--markdown") {
      parsed.markdown = true;
    } else if (arg === "--html") {
      parsed.htmlOut = requireVal(argv, i, "--html");
      i++;
    } else if (!arg.startsWith("-")) {
      parsed.files.push(arg);
    } else {
      throw new Error(`Unknown argument "${arg}". Run \`planflare --help\`.`);
    }
  }

  if (parsed.mode === "diff" && parsed.files.length !== 2) {
    throw new Error("Usage: planflare diff <before.json> <after.json>");
  }
  if (parsed.mode === "analyze" && parsed.files.length > 1) {
    throw new Error("Expected at most one <plan.json> file (or pipe JSON via stdin).");
  }

  return parsed;
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.mode === "help") {
    printHelp();
    return;
  }

  if (args.mode === "demo") {
    const before = analyzeExplainPlan(DEMO_BEFORE_PLAN);
    const after = analyzeExplainPlan(DEMO_AFTER_PLAN);
    const diff = diffPlans(before, after);

    if (args.htmlOut) {
      const outAbs = resolve(args.htmlOut);
      mkdirSync(dirname(outAbs), { recursive: true });
      writeFileSync(outAbs, formatHtmlFlamegraph(before, "planflare Demo (Before Index)"), "utf8");
    }

    if (args.json) {
      console.log(JSON.stringify(diff, null, 2));
      return;
    }
    if (args.markdown) {
      console.log(formatMarkdownDiff(diff));
      return;
    }
    console.log(formatTerminalFlamegraph(before));
    console.log("\n---\n");
    console.log(formatTerminalDiff(diff));
    return;
  }

  if (args.mode === "diff") {
    const before = analyzeExplainPlan(parseExplainJson(readFileSync(resolve(args.files[0]), "utf8")));
    const after = analyzeExplainPlan(parseExplainJson(readFileSync(resolve(args.files[1]), "utf8")));
    const diff = diffPlans(before, after);
    if (args.json) {
      console.log(JSON.stringify(diff, null, 2));
    } else if (args.markdown) {
      console.log(formatMarkdownDiff(diff));
    } else {
      console.log(formatTerminalDiff(diff));
    }
    return;
  }

  const rawText =
    args.files.length === 1
      ? readFileSync(resolve(args.files[0]), "utf8")
      : process.stdin.isTTY
        ? ""
        : await readStdinText();

  if (!rawText.trim()) {
    printHelp();
    return;
  }

  const analysis = analyzeExplainPlan(parseExplainJson(rawText));
  if (args.htmlOut) {
    const outAbs = resolve(args.htmlOut);
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, formatHtmlFlamegraph(analysis), "utf8");
  }

  if (args.json) {
    console.log(JSON.stringify(analysis, null, 2));
  } else {
    console.log(formatTerminalFlamegraph(analysis));
  }
}

function isDirectEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)).toLowerCase() ===
      realpathSync(resolve(process.argv[1])).toLowerCase()
    );
  } catch {
    return resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();
  }
}

if (isDirectEntry()) {
  main().catch((err) => {
    console.error(`[planflare] Error: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
