/**
 * control.json IPC 测试
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 模拟 helpers 的逻辑（不引入 commander 依赖）
function writeControlFile(path: string, action: string, name: string): void {
  writeFileSync(path, JSON.stringify({ action, name, ts: Date.now() }), "utf-8");
}

async function waitForDelete(path: string, timeoutMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

let tmpDir: string;
let controlPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "svcctl-control-test-"));
  controlPath = join(tmpDir, "control.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("control.json format", () => {
  test("writes valid JSON with action, name, ts", () => {
    writeControlFile(controlPath, "start", "myapp");
    expect(existsSync(controlPath)).toBe(true);
    const raw = JSON.parse(require("node:fs").readFileSync(controlPath, "utf-8"));
    expect(raw.action).toBe("start");
    expect(raw.name).toBe("myapp");
    expect(typeof raw.ts).toBe("number");
  });

  test("stop action", () => {
    writeControlFile(controlPath, "stop", "worker");
    const raw = JSON.parse(require("node:fs").readFileSync(controlPath, "utf-8"));
    expect(raw.action).toBe("stop");
  });

  test("restart action", () => {
    writeControlFile(controlPath, "restart", "server");
    const raw = JSON.parse(require("node:fs").readFileSync(controlPath, "utf-8"));
    expect(raw.action).toBe("restart");
  });
});

describe("waitForControlProcessed", () => {
  test("returns true when file is deleted", async () => {
    writeControlFile(controlPath, "start", "app");
    // delete after 100ms (simulating supervisor processing)
    setTimeout(() => { try { unlinkSync(controlPath); } catch {} }, 100);
    const ok = await waitForDelete(controlPath, 2000);
    expect(ok).toBe(true);
  });

  test("returns false on timeout", async () => {
    writeControlFile(controlPath, "start", "app");
    // never delete — should timeout
    const ok = await waitForDelete(controlPath, 200);
    expect(ok).toBe(false);
  });

  test("returns true immediately if file doesn't exist", async () => {
    const ok = await waitForDelete(controlPath, 500);
    expect(ok).toBe(true);
  });
});
