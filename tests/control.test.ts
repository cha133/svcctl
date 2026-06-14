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

// v0.4.9: 模拟 waitForEntryGone 的核心逻辑（不引入 src/ 避免依赖副作用）
function readEntryPid(childrenPath: string, name: string): number | null {
  if (!existsSync(childrenPath)) return null;
  const data = JSON.parse(require("node:fs").readFileSync(childrenPath, "utf-8")) as Record<string, number | null>;
  return data[name] ?? null;
}

async function waitForEntryGone(
  name: string,
  timeoutMs: number,
  childrenPath: string
): Promise<"gone" | "timeout"> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (readEntryPid(childrenPath, name) === null) return "gone";
    await new Promise((r) => setTimeout(r, 50));
  }
  return "timeout";
}

let tmpDir: string;
let controlPath: string;
let childrenPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "svcctl-control-test-"));
  controlPath = join(tmpDir, "control.json");
  childrenPath = join(tmpDir, "children.json");
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

describe("waitForEntryGone (v0.4.9)", () => {
  test("returns 'gone' when entry disappears from children.json", async () => {
    writeFileSync(childrenPath, JSON.stringify({ "cctra-serve": 12345 }));
    // 200ms 后模拟 supervisor kill 完 → write_children_json 删 entry
    setTimeout(() => {
      writeFileSync(childrenPath, JSON.stringify({})); // entry 被 omit
    }, 200);
    const result = await waitForEntryGone("cctra-serve", 2000, childrenPath);
    expect(result).toBe("gone");
  });

  test("returns 'timeout' when entry stays in children.json", async () => {
    writeFileSync(childrenPath, JSON.stringify({ "stuck": 99999 }));
    // 永远不删
    const result = await waitForEntryGone("stuck", 200, childrenPath);
    expect(result).toBe("timeout");
  });

  test("returns 'gone' immediately when children.json doesn't have the entry (idempotent)", async () => {
    // 模拟 entry 从未跑过 / 已 stopped 状态
    writeFileSync(childrenPath, JSON.stringify({ "other-entry": 111 }));
    const result = await waitForEntryGone("never-ran", 1000, childrenPath);
    expect(result).toBe("gone");
  });

  test("returns 'gone' immediately when children.json missing", async () => {
    // 模拟 supervisor 完全没写过 children.json
    expect(existsSync(childrenPath)).toBe(false);
    const result = await waitForEntryGone("any", 1000, childrenPath);
    expect(result).toBe("gone");
  });
});
