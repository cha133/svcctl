/**
 * enable / disable 命令测试
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEntriesAt, saveEntriesAt, addEntryAt } from "./store-helpers";
import type { Entry } from "../src/entries/types";

let tmpDir: string;
let tomlPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "svcctl-enable-test-"));
  tomlPath = join(tmpDir, "entries.toml");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function enableEntry(name: string): void {
  const file = loadEntriesAt(tomlPath);
  const entry = file.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`entry "${name}" not found`);
  delete entry.startup;
  saveEntriesAt(file, tomlPath);
}

function disableEntry(name: string): void {
  const file = loadEntriesAt(tomlPath);
  const entry = file.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`entry "${name}" not found`);
  entry.startup = false;
  saveEntriesAt(file, tomlPath);
}

describe("enable", () => {
  test("removes startup field from disabled entry", () => {
    const entry: Entry = {
      name: "myapp",
      command: "bun",
      args: ["run", "app.ts"],
      createdAt: "2026-06-08T10:00:00.000Z",
      startup: false,
    };
    addEntryAt(entry, tomlPath);
    enableEntry("myapp");
    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.startup).toBeUndefined();
  });

  test("is idempotent on already-enabled entry", () => {
    const entry: Entry = {
      name: "myapp",
      command: "bun",
      args: [],
      createdAt: "2026-06-08T10:00:00.000Z",
      // no startup field = default true
    };
    addEntryAt(entry, tomlPath);
    enableEntry("myapp"); // should not throw
    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.startup).toBeUndefined();
  });
});

describe("disable", () => {
  test("sets startup: false on enabled entry", () => {
    const entry: Entry = {
      name: "myapp",
      command: "bun",
      args: ["run", "app.ts"],
      createdAt: "2026-06-08T10:00:00.000Z",
      // no startup field = default true
    };
    addEntryAt(entry, tomlPath);
    disableEntry("myapp");
    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.startup).toBe(false);
  });

  test("is idempotent on already-disabled entry", () => {
    const entry: Entry = {
      name: "myapp",
      command: "bun",
      args: [],
      createdAt: "2026-06-08T10:00:00.000Z",
      startup: false,
    };
    addEntryAt(entry, tomlPath);
    disableEntry("myapp"); // should not throw
    const read = loadEntriesAt(tomlPath);
    expect(read.entries[0]?.startup).toBe(false);
  });
});

describe("enable/disable round-trip", () => {
  test("disable then enable restores default", () => {
    const entry: Entry = {
      name: "roundtrip",
      command: "node",
      args: ["s.js"],
      createdAt: "2026-06-08T10:00:00.000Z",
    };
    addEntryAt(entry, tomlPath);

    disableEntry("roundtrip");
    expect(loadEntriesAt(tomlPath).entries[0]?.startup).toBe(false);

    enableEntry("roundtrip");
    expect(loadEntriesAt(tomlPath).entries[0]?.startup).toBeUndefined();

    disableEntry("roundtrip");
    expect(loadEntriesAt(tomlPath).entries[0]?.startup).toBe(false);
  });
});

describe("multiple entries", () => {
  test("enable/disable only affects target entry", () => {
    const e1: Entry = { name: "app1", command: "bun", args: ["a1.ts"], createdAt: "2026-06-08T10:00:00.000Z" };
    const e2: Entry = { name: "app2", command: "bun", args: ["a2.ts"], createdAt: "2026-06-08T10:00:00.000Z" };
    addEntryAt(e1, tomlPath);
    addEntryAt(e2, tomlPath);

    disableEntry("app1");

    const read = loadEntriesAt(tomlPath);
    expect(read.entries.find((e) => e.name === "app1")?.startup).toBe(false);
    expect(read.entries.find((e) => e.name === "app2")?.startup).toBeUndefined();

    enableEntry("app1");
    const read2 = loadEntriesAt(tomlPath);
    expect(read2.entries.find((e) => e.name === "app1")?.startup).toBeUndefined();
  });
});
