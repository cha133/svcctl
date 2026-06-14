/**
 * v0.4.7: opt-in `restart` 字段测试
 *
 * 背景：v0.4.7 之前 supervisor 默认会重启死掉的子进程（reap 块无脑 spawn）。
 * 大部分程序内部都有全局 catch 不容易死，supervisor 兜底是额外复杂度。
 * v0.4.7 起：默认不重启，opt-in 通过 `restart = true` 在 entries.toml 或
 * `svcctl add --restart` 启用。
 *
 * Rust 端 supervisor 行为（死了是否重启）由手动 smoke 验证；
 * 本测试覆盖 schema round-trip + add --restart 写 toml 正确性。
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEntriesAt, addEntryAt } from "./store-helpers";
import type { Entry } from "../src/entries/types";

let tmpDir: string;
let tomlPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "svcctl-restart-test-"));
  tomlPath = join(tmpDir, "entries.toml");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("restart 字段 schema round-trip", () => {
  test("restart: true 写入 toml → 读出 restart === true", () => {
    const entry: Entry = {
      name: "auto-restart-app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      restart: true,
    };
    addEntryAt(entry, tomlPath);
    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.restart).toBe(true);
  });

  test("restart: true 在 TOML 原文里以 'restart = true' 出现", () => {
    const entry: Entry = {
      name: "app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      restart: true,
    };
    addEntryAt(entry, tomlPath);
    const raw = readFileSync(tomlPath, "utf-8");
    expect(raw).toContain("restart = true");
  });

  test("addEntry 不带 restart 字段 → 写出的 toml 没有 restart 行", () => {
    const entry: Entry = {
      name: "no-crash-recovery",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      // 没 restart 字段 → 默认 false（不重启）
    };
    addEntryAt(entry, tomlPath);
    const raw = readFileSync(tomlPath, "utf-8");
    expect(raw).not.toContain("restart");
  });

  test("restart: false 显式写也能 round-trip（虽然默认值就是 false）", () => {
    const entry: Entry = {
      name: "app",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      restart: false,
    };
    addEntryAt(entry, tomlPath);
    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.restart).toBe(false);
  });
});

describe("startup + restart 组合", () => {
  test("startup: false + restart: true → 不会随 supervisor 启动拉起，但被 svcctl start 后死了会重启", () => {
    const entry: Entry = {
      name: "manual-auto-restart",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      startup: false,
      restart: true,
    };
    addEntryAt(entry, tomlPath);
    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.startup).toBe(false);
    expect(read.entries[0]?.restart).toBe(true);
  });

  test("startup 缺失 + restart: true → 随 supervisor 启动 + 死了会重启", () => {
    const entry: Entry = {
      name: "always-on",
      command: "node",
      args: ["app.js"],
      createdAt: "2026-06-14T08:00:00.000Z",
      restart: true,
    };
    addEntryAt(entry, tomlPath);
    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.startup).toBeUndefined();
    expect(read.entries[0]?.restart).toBe(true);
  });
});
