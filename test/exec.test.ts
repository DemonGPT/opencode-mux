import { describe, expect, it } from "vitest";
import { nodeExec } from "../src/exec.ts";

describe("nodeExec", () => {
  const exec = nodeExec();

  it("runs a command and captures stdout", async () => {
    const r = await exec.run("node", ["-e", "process.stdout.write('hi')"]);
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi");
    expect(r.stderr).toBe("");
    expect(r.error).toBeNull();
  });

  it("reports a non-zero exit as failure", async () => {
    const r = await exec.run("node", ["-e", "process.stderr.write('boom'); process.exit(3)"]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe("boom");
  });

  it("reports a missing binary as failure without throwing", async () => {
    const r = await exec.run("definitely-not-a-real-binary-xyz", []);
    expect(r.ok).toBe(false);
    expect(r.code).toBeNull();
    expect(r.error).not.toBeNull();
  });
});
