import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommand } from "../src/entries/resolve";

let root: string;
let binA: string;
let binB: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "svcctl-resolve-"));
  binA = join(root, "binA");
  binB = join(root, "binB");
  mkdirSync(binA);
  mkdirSync(binB);
  // binA: 只有无扩展名 bash shim + .cmd（模拟 scoop/npm 的 dsh）
  writeFileSync(join(binA, "dsh"), "#!/bin/sh\n");
  writeFileSync(join(binA, "dsh.cmd"), "@echo off\n");
  // binB: 同时有 .exe 和 .cmd（PATHEXT 顺序 .EXE 优先）
  writeFileSync(join(binB, "tool.exe"), "MZ");
  writeFileSync(join(binB, "tool.cmd"), "@echo off\n");
  // binB: 磁盘上是大写扩展名的文件（resolver 要保留真实大小写）
  writeFileSync(join(binB, "MixedCase.CMD"), "@echo off\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const winEnv = () => ({
  platform: "win32" as const,
  path: [binA, binB].join(";"),
  pathext: ".COM;.EXE;.BAT;.CMD",
});

describe("resolveCommand (win32)", () => {
  test("bare name with only extensionless shim + .cmd → resolves to .cmd", () => {
    expect(resolveCommand("dsh", winEnv())).toBe(join(binA, "dsh.cmd"));
  });

  test("PATHEXT order: .exe wins over .cmd in same dir", () => {
    expect(resolveCommand("tool", winEnv())).toBe(join(binB, "tool.exe"));
  });

  test("preserves on-disk filename case (PATHEXT is uppercase, disk may differ)", () => {
    expect(resolveCommand("mixedcase", winEnv())).toBe(join(binB, "MixedCase.CMD"));
  });

  test("path separator → null (explicit path not resolved)", () => {
    expect(resolveCommand("C:\\Tools\\dsh.cmd", winEnv())).toBe(null);
    expect(resolveCommand("./dsh", winEnv())).toBe(null);
  });

  test("not found → null", () => {
    expect(resolveCommand("nonexistent-xyz", winEnv())).toBe(null);
  });

  test("explicit extension in PATHEXT → resolves", () => {
    expect(resolveCommand("dsh.cmd", winEnv())).toBe(join(binA, "dsh.cmd"));
  });

  test("explicit extension NOT in PATHEXT → null", () => {
    expect(resolveCommand("dsh.sh", winEnv())).toBe(null);
  });

  test("empty PATH segments are skipped", () => {
    const env = { ...winEnv(), path: `;${binA};;` };
    expect(resolveCommand("dsh", env)).toBe(join(binA, "dsh.cmd"));
  });
});
