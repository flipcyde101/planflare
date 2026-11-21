import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEMO_AFTER_PLAN, DEMO_BEFORE_PLAN } from "../src/demo/fixture.js";

describe("built dist/cli.js end-to-end (stdin pipe, diff, --demo, --html)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("runs --demo --json, diff, and stdin pipe cleanly", () => {
    const cliPath = resolve(process.cwd(), "dist", "cli.js");
    const demoJson = JSON.parse(execFileSync(process.execPath, [cliPath, "--demo", "--json"], { encoding: "utf8" })) as {
      deltaPct: number;
      resolvedHotspots: unknown[];
    };
    expect(demoJson.deltaPct).toBe(-99.8);
    expect(demoJson.resolvedHotspots.length).toBeGreaterThanOrEqual(4);

    const dir = mkdtempSync(join(tmpdir(), "pf-e2e-"));
    dirs.push(dir);
    const beforePath = join(dir, "before.json");
    const afterPath = join(dir, "after.json");
    const htmlPath = join(dir, "out.html");
    writeFileSync(beforePath, JSON.stringify([DEMO_BEFORE_PLAN]), "utf8");
    writeFileSync(afterPath, JSON.stringify([DEMO_AFTER_PLAN]), "utf8");

    const mdOut = execFileSync(process.execPath, [cliPath, "diff", beforePath, afterPath, "--markdown"], { encoding: "utf8" });
    expect(mdOut).toContain("-99.8%");

    // Stdin pipe mode + HTML export
    const pipeOut = execFileSync(process.execPath, [cliPath, "--html", htmlPath], {
      input: JSON.stringify([DEMO_BEFORE_PLAN]),
      encoding: "utf8",
    });
    expect(pipeOut).toContain("Seq Scan on orders");
    expect(existsSync(htmlPath)).toBe(true);
    expect(readFileSync(htmlPath, "utf8")).toContain("planflare");
  });
});
