import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const recoveryPath = "deploy/scripts/recover-ubuntu.sh";

describe("Ubuntu failed-deployment recovery", () => {
  it("is valid bash and preserves the normal bootstrap clean-check", async () => {
    const syntax = spawnSync("bash", ["-n", recoveryPath], { encoding: "utf8" });
    expect(syntax.status, syntax.stderr).toBe(0);

    const bootstrap = await readFile("deploy/scripts/bootstrap-ubuntu.sh", "utf8");
    expect(bootstrap).toContain("source checkout is not clean; commit/stash changes before deploying");
  });

  it("deploys an exact committed revision from a separate clean worktree", async () => {
    const script = await readFile(recoveryPath, "utf8");

    expect(script).toContain('rev-parse --verify "${TARGET_REF}^{commit}"');
    expect(script).toContain('worktree add --detach "$RECOVERY_TREE" "$TARGET_SHA"');
    expect(script).toContain('status --porcelain');
    expect(script).toContain('rev-parse HEAD');
    expect(script).toContain('/usr/bin/bash "$RECOVERY_TREE/deploy/scripts/bootstrap-ubuntu.sh"');
  });

  it("never destroys or rewrites the operator's dirty checkout", async () => {
    const script = await readFile(recoveryPath, "utf8");

    expect(script).not.toMatch(/\bgit\s+reset\b/);
    expect(script).not.toMatch(/\bgit\s+clean\b/);
    expect(script).not.toMatch(/\bgit\s+stash\b/);
    expect(script).not.toContain("checkout --");
    expect(script).toContain("Never reset, clean,");
  });
});
