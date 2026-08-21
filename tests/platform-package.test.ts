import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  defaultWindowsSupervisorPath,
  windowsPlatformPackageName,
} from "../src/install";

describe("Windows platform package resolution", () => {
  test("maps supported process architectures to npm packages", () => {
    expect(windowsPlatformPackageName("x64")).toBe("svcctl-win32-x64");
    expect(windowsPlatformPackageName("arm64")).toBe("svcctl-win32-arm64");
  });

  test("rejects unsupported Windows architectures", () => {
    expect(() => windowsPlatformPackageName("ia32")).toThrow("Unsupported Windows architecture: ia32");
  });

  const nativePackageBuilt = (() => {
    try {
      return existsSync(defaultWindowsSupervisorPath());
    } catch {
      return false;
    }
  })();

  test.if(nativePackageBuilt)("resolves the built native supervisor from the platform package", () => {
    expect(defaultWindowsSupervisorPath()).toEndWith("SvcCtl.exe");
    expect(existsSync(defaultWindowsSupervisorPath())).toBe(true);
  });
});
