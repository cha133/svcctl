import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadEntriesAt,
  saveEntriesAt,
  addEntryAt,
  removeEntryAt,
} from "./store-helpers";
import { emptyEntriesFile } from "../src/entries/types";
import type { Entry } from "../src/entries/types";

let tmpDir: string;
let tomlPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "svcctl-store-test-"));
  tomlPath = join(tmpDir, "entries.toml");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadEntriesAt", () => {
  test("returns empty when file missing", () => {
    const f = loadEntriesAt(tomlPath);
    expect(f).toEqual(emptyEntriesFile());
  });

  test("returns empty when file is empty string", () => {
    const f = loadEntriesAt(tomlPath);
    expect(f.entries).toEqual([]);
  });

  test("round-trips written file", () => {
    const written = {
      version: 1,
      entries: [
        {
          name: "bunx-cctra",
          command: "bunx",
          args: ["cctra"],
          createdAt: "2026-06-08T10:00:00.000Z",
        },
      ],
    };
    saveEntriesAt(written, tomlPath);
    const read = loadEntriesAt(tomlPath);
    expect(read).toEqual(written);
    expect(existsSync(tomlPath)).toBe(true);
  });
});

describe("addEntryAt", () => {
  test("appends and persists", () => {
    const entry: Entry = {
      name: "foo",
      command: "bun",
      args: ["run", "foo.js"],
      createdAt: "2026-06-08T10:00:00.000Z",
    };
    addEntryAt(entry, tomlPath);
    const read = loadEntriesAt(tomlPath);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toEqual(entry);
  });

  test("rejects duplicate name", () => {
    const entry: Entry = {
      name: "foo",
      command: "bun",
      args: [],
      createdAt: "2026-06-08T10:00:00.000Z",
    };
    addEntryAt(entry, tomlPath);
    expect(() => addEntryAt(entry, tomlPath)).toThrow(/already exists/);
  });
});

describe("removeEntryAt", () => {
  test("removes existing", () => {
    const entry: Entry = {
      name: "foo",
      command: "bun",
      args: [],
      createdAt: "2026-06-08T10:00:00.000Z",
    };
    addEntryAt(entry, tomlPath);
    removeEntryAt("foo", tomlPath);
    expect(loadEntriesAt(tomlPath).entries).toEqual([]);
  });

  test("throws on missing", () => {
    expect(() => removeEntryAt("nope", tomlPath)).toThrow(/not found/);
  });
});

describe("file content", () => {
  test("written file is valid TOML", () => {
    const written = {
      version: 1,
      entries: [
        {
          name: "foo",
          command: "bun",
          args: ["run", "foo.js"],
          cwd: "/tmp",
          env: { NODE_ENV: "production" },
          createdAt: "2026-06-08T10:00:00.000Z",
        },
      ],
    };
    saveEntriesAt(written, tomlPath);
    const raw = readFileSync(tomlPath, "utf-8");
    expect(raw).toContain("name = \"foo\"");
    expect(raw).toContain("command = \"bun\"");
    expect(raw).toContain("NODE_ENV");
  });
});
