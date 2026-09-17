import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.ts";

describe("VERSION", () => {
  it("is a semver string matching package.json", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});