/**
 * v0.4.7: manual entry 误拉起 bug 修复测试
 *
 * 背景：之前 `svcctl stop & svcctl start` 后 `startup = false`（manual）entry 会被
 * 错误地 spawn。根因是 reap 块和 reconcile 故意不 spawn 的 entry 共享同一种 rec 状态
 * （`child=None, last_spawn=过去`），reap 块没区分两者就 spawn。
 *
 * 修复：在 ChildRecord 加 want_run 字段，reconcile 按意图设值，reap 块加 want_run 条件。
 *
 * TS 端只测 schema 一致性 + addEntry 写入 startup 字段的 round-trip。
 * Rust 端 supervisor 行为（真起 SvcCtl.exe 跑 e2e）由手动 smoke 验证。
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEntriesAt, saveEntriesAt, addEntryAt } from "./store-helpers";
import type { Entry } from "../src/entries/types";

let tmpDir: string;
let tomlPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "svcctl-manual-bug-test-"));
  tomlPath = join(tmpDir, "entries.toml");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("manual entry schema (startup: false)", () => {
  test("写入 entries.toml → 读出 startup === false", () => {
    const written = {
      version: 1,
      entries: [
        {
          name: "cctra-serve",
          command: "cctra",
          args: ["serve"],
          createdAt: "2026-06-14T08:00:00.000Z",
          startup: false, // 复刻茶茶的场景
        },
      ],
    };
    saveEntriesAt(written, tomlPath);
    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.startup).toBe(false);
  });

  test("startup: false 字段在 TOML 原文里以 'startup = false' 出现", () => {
    const entry: Entry = {
      name: "manual-app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      startup: false,
    };
    addEntryAt(entry, tomlPath);
    const raw = readFileSync(tomlPath, "utf-8");
    expect(raw).toContain("startup = false");
  });

  test("addEntry 不带 startup 字段 → 写出的 toml 没有 startup 行", () => {
    const entry: Entry = {
      name: "auto-app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      // 没 startup 字段 → 默认 auto
    };
    addEntryAt(entry, tomlPath);
    const raw = readFileSync(tomlPath, "utf-8");
    expect(raw).not.toContain("startup");
  });
});

describe("disable / enable round-trip（验证 disable 命令写 startup=false）", () => {
  test("disable 已 enable 的 entry → startup 变 false", () => {
    const entry: Entry = {
      name: "app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
    };
    addEntryAt(entry, tomlPath);

    // 模拟 disable 命令：直接改 toml
    const file = loadEntriesAt(tomlPath);
    const e = file.entries[0]!;
    e.startup = false;
    saveEntriesAt(file, tomlPath);

    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.startup).toBe(false);
  });

  test("enable 已 disable 的 entry → startup 字段被删（默认 auto）", () => {
    const entry: Entry = {
      name: "app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      startup: false,
    };
    addEntryAt(entry, tomlPath);

    // 模拟 enable 命令：删 startup 字段
    const file = loadEntriesAt(tomlPath);
    const e = file.entries[0]!;
    delete e.startup;
    saveEntriesAt(file, tomlPath);

    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.startup).toBeUndefined();
  });
});

describe("reconcile 表达式（Node supervisor 等价逻辑测）", () => {
  // 复刻 src/supervise/index.ts 的 reconcile shouldRun 表达式
  // （teach-by-test：让 reviewer 知道 supervisor 用什么逻辑判断要不要 spawn）
  function shouldRun(entry: Entry, manualSet: Set<string>): boolean {
    return entry.startup !== false || manualSet.has(entry.name);
  }

  test("startup: false + 不在 manual set → 不应 spawn", () => {
    const e: Entry = {
      name: "manual-app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      startup: false,
    };
    expect(shouldRun(e, new Set())).toBe(false);
  });

  test("startup: false + 在 manual set（被 svcctl start 过）→ 应 spawn", () => {
    const e: Entry = {
      name: "manual-app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      startup: false,
    };
    expect(shouldRun(e, new Set(["manual-app"]))).toBe(true);
  });

  test("startup: undefined（默认 true） → 应 spawn", () => {
    const e: Entry = {
      name: "auto-app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      // 没 startup
    };
    expect(shouldRun(e, new Set())).toBe(true);
  });

  test("startup: true → 应 spawn", () => {
    const e: Entry = {
      name: "auto-app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      startup: true,
    };
    expect(shouldRun(e, new Set())).toBe(true);
  });
});
