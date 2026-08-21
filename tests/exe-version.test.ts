import { describe, expect, test } from "bun:test";
import { normalizeVersion } from "../src/install/exe-version";

describe("normalizeVersion", () => {
  test("removes only the fourth zero component from a PE version", () => {
    expect(normalizeVersion("0.6.0.0")).toBe("0.6.0");
    expect(normalizeVersion("1.2.3.0")).toBe("1.2.3");
  });

  test("preserves a three-component semver ending in zero", () => {
    expect(normalizeVersion("0.6.0")).toBe("0.6.0");
    expect(normalizeVersion("1.0.0")).toBe("1.0.0");
  });

  test("preserves other version strings", () => {
    expect(normalizeVersion("1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeVersion("")).toBe("");
  });
});
