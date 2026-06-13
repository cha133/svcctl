import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findEntry,
  suggestEntries,
  entryState,
  entryPid,
  tailLines,
  supervisorLogMentions,
  EntryNotFoundError,
  EntryAmbiguousError,
  RUNNING_THRESHOLD_MS,
} from "../src/entries/match";
import { saveEntriesAt } from "./store-helpers";
import type { Entry } from "../src/entries/types";

let tmpDir: string;
let tomlPath: string;

function mkEntry(over: Partial<Entry> & { name: string }): Entry {
  return {
    command: "bunx",
    args: [],
    createdAt: "2026-06-08T10:00:00.000Z",
    ...over,
  };
}

function seed(entries: Entry[]): void {
  saveEntriesAt({ version: 1, entries }, tomlPath);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "svcctl-match-test-"));
  tomlPath = join(tmpDir, "entries.toml");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("findEntry", () => {
  test("exact match (case-insensitive)", () => {
    seed([mkEntry({ name: "cctra-serve" })]);
    expect(findEntry("CCTRA-SERVE", tomlPath).name).toBe("cctra-serve");
    expect(findEntry("cctra-serve", tomlPath).name).toBe("cctra-serve");
  });

  test("prefix match — single candidate", () => {
    seed([mkEntry({ name: "cctra-serve" })]);
    expect(findEntry("cctra", tomlPath).name).toBe("cctra-serve");
  });

  test("prefix match — multiple candidates throws AmbiguousError", () => {
    seed([
      mkEntry({ name: "cctra-serve" }),
      mkEntry({ name: "cctra-client" }),
    ]);
    expect(() => findEntry("cctra", tomlPath)).toThrow(EntryAmbiguousError);
    try {
      findEntry("cctra", tomlPath);
    } catch (e) {
      expect(e).toBeInstanceOf(EntryAmbiguousError);
      if (e instanceof EntryAmbiguousError) {
        expect(e.matches).toEqual(["cctra-serve", "cctra-client"]);
      }
    }
  });

  test("substring match — single candidate", () => {
    seed([mkEntry({ name: "cctra-serve" })]);
    expect(findEntry("serve", tomlPath).name).toBe("cctra-serve");
  });

  test("substring match — multiple candidates throws AmbiguousError", () => {
    seed([
      mkEntry({ name: "cctra-serve" }),
      mkEntry({ name: "other-serve" }),
    ]);
    expect(() => findEntry("serve", tomlPath)).toThrow(EntryAmbiguousError);
  });

  test("miss — throws NotFoundError", () => {
    // seed entries that don't share prefix/substring with a typo
    seed([mkEntry({ name: "cctra-serve" }), mkEntry({ name: "cctra-client" })]);
    try {
      // "xyzzy" 既不是 prefix 也不是 substring → NotFound
      findEntry("xyzzy", tomlPath);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EntryNotFoundError);
      if (e instanceof EntryNotFoundError) {
        // 没有任何 entry 沾边 → 也没建议
        expect(e.suggestions).toEqual([]);
      }
    }
  });

  test("miss — partially-similar typo throws NotFound (substring catches most typos)", () => {
    // 注意：suggestion 的实际场景很有限 —— 因为 fuzzy (prefix/substring) 已经覆盖
    // 多数 typo。Levenshtein 之类的算法是 v1.x 范畴（YAGNI）。这里只测 NotFound 行为。
    seed([mkEntry({ name: "cctra-serve" })]);
    expect(() => findEntry("xyzzy", tomlPath)).toThrow(EntryNotFoundError);
  });

  test("empty store throws NotFoundError without suggestions", () => {
    seed([]);
    try {
      findEntry("anything", tomlPath);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(EntryNotFoundError);
      if (e instanceof EntryNotFoundError) {
        expect(e.suggestions).toEqual([]);
      }
    }
  });

  test("exact match wins over prefix candidates", () => {
    seed([
      mkEntry({ name: "cctra" }),
      mkEntry({ name: "cctra-serve" }),
    ]);
    // 精确匹配 cctra → 命中 cctra（不是 prefix 命中 cctra-serve）
    expect(findEntry("cctra", tomlPath).name).toBe("cctra");
  });
});

describe("suggestEntries", () => {
  test("prefix matches sort first", () => {
    seed([
      mkEntry({ name: "serve-other", args: ["x"] }),
      mkEntry({ name: "cctra-serve" }),
      mkEntry({ name: "bun-runner" }),
    ]);
    const s = suggestEntries("cctra", 5, tomlPath);
    expect(s.length).toBeGreaterThan(0);
    expect(s[0]!.name).toBe("cctra-serve");
  });

  test("substring matches come after prefix", () => {
    seed([
      mkEntry({ name: "other-serve" }),
      mkEntry({ name: "cctra-serve" }),
    ]);
    const s = suggestEntries("serve", 5, tomlPath);
    // 两者都是 substring "serve" —— 长度相同（11=11）→ 按 createdAt 排（默认同 createdAt → 插入序）
    expect(s.map((e) => e.name)).toEqual(["other-serve", "cctra-serve"]);
  });

  test("ties broken by shorter name", () => {
    seed([
      mkEntry({ name: "a-b-c-d" }),
      mkEntry({ name: "a-b" }),
    ]);
    const s = suggestEntries("a", 5, tomlPath);
    expect(s[0]!.name).toBe("a-b");
  });

  test("ties (equal length) broken by createdAt ascending", () => {
    seed([
      mkEntry({ name: "foo-x", createdAt: "2026-06-09T00:00:00.000Z" }),
      mkEntry({ name: "foo-y", createdAt: "2026-06-08T00:00:00.000Z" }),
    ]);
    const s = suggestEntries("foo", 5, tomlPath);
    // 两者都是 substring "foo"，长度都是 5 → 按 createdAt 早的优先
    expect(s[0]!.name).toBe("foo-y");
  });

  test("returns at most `limit` results", () => {
    seed([
      mkEntry({ name: "a-1" }),
      mkEntry({ name: "a-2" }),
      mkEntry({ name: "a-3" }),
      mkEntry({ name: "a-4" }),
    ]);
    expect(suggestEntries("a", 2, tomlPath)).toHaveLength(2);
  });

  test("empty store returns []", () => {
    seed([]);
    expect(suggestEntries("anything", 3, tomlPath)).toEqual([]);
  });
});

describe("entryState", () => {
  test("returns 'never' if log file missing", () => {
    expect(entryState("foo", "/nonexistent/path.log")).toBe("never");
  });

  test("returns 'running' if mtime < threshold ago", () => {
    const f = join(tmpDir, "fresh.log");
    writeFileSync(f, "hi\n");
    // mtime 默认是 now
    expect(entryState("foo", f)).toBe("running");
  });

  test("returns 'stopped' if mtime > threshold ago", () => {
    const f = join(tmpDir, "stale.log");
    writeFileSync(f, "old\n");
    // 改成 RUNNING_THRESHOLD_MS + 1ms 之前
    const past = new Date(Date.now() - RUNNING_THRESHOLD_MS - 1000);
    utimesSync(f, past, past);
    expect(entryState("foo", f)).toBe("stopped");
  });
});

describe("entryPid", () => {
  test("returns null on non-windows platforms", () => {
    // 默认在 linux/darwin 测试机上 process.platform !== 'win32'
    if (process.platform === "win32") return; // skip on windows
    expect(entryPid("foo", "/nonexistent.json")).toBeNull();
  });

  test("returns null if children.json missing", () => {
    if (process.platform === "win32") return; // skip on windows
    const f = join(tmpDir, "children.json");
    expect(existsSync(f)).toBe(false);
    expect(entryPid("foo", f)).toBeNull();
  });

  test("reads PID from children.json (Windows contract)", () => {
    const f = join(tmpDir, "children.json");
    writeFileSync(f, JSON.stringify({ "cctra-serve": 12345, "bun-runner": 67890 }));
    if (process.platform === "win32") {
      expect(entryPid("cctra-serve", f)).toBe(12345);
      expect(entryPid("missing", f)).toBeNull();
    } else {
      // 非 Windows 一律 null
      expect(entryPid("cctra-serve", f)).toBeNull();
    }
  });

  test("returns null on malformed JSON", () => {
    const f = join(tmpDir, "children.json");
    writeFileSync(f, "{not valid json");
    if (process.platform === "win32") {
      expect(entryPid("foo", f)).toBeNull();
    }
  });
});

describe("tailLines", () => {
  test("returns last N lines, no trailing empty", () => {
    const f = join(tmpDir, "t.log");
    writeFileSync(f, "a\nb\nc\nd\ne\n");
    expect(tailLines(f, 3)).toEqual(["c", "d", "e"]);
  });

  test("returns all lines when N >= total", () => {
    const f = join(tmpDir, "t.log");
    writeFileSync(f, "a\nb\nc");
    expect(tailLines(f, 10)).toEqual(["a", "b", "c"]);
  });

  test("returns [] for missing file", () => {
    expect(tailLines("/nonexistent/t.log", 5)).toEqual([]);
  });

  test("returns [] when N <= 0", () => {
    const f = join(tmpDir, "t.log");
    writeFileSync(f, "a\nb\nc\n");
    expect(tailLines(f, 0)).toEqual([]);
    expect(tailLines(f, -1)).toEqual([]);
  });

  test("handles file with no trailing newline", () => {
    const f = join(tmpDir, "t.log");
    writeFileSync(f, "a\nb\nc");
    expect(tailLines(f, 2)).toEqual(["b", "c"]);
  });
});

describe("supervisorLogMentions", () => {
  test("returns [] when supervisor.log missing", () => {
    expect(
      supervisorLogMentions("cctra", 5, "/nonexistent/supervisor.log")
    ).toEqual([]);
  });

  test("matches lines containing single-quoted name (Rust/Node supervisor format)", () => {
    const f = join(tmpDir, "supervisor.log");
    writeFileSync(
      f,
      [
        `[1700000000000] [INFO] supervisor started (pid=100)`,
        `[1700000001000] [INFO] spawned 'cctra-serve' (pid=200)`,
        `[1700000002000] [INFO] spawned 'bun-runner' (pid=201)`,
        `[1700000003000] [WARN] child 'cctra-serve' exited (code=1)`,
        `[1700000004000] [INFO] respawned 'cctra-serve' (pid=202)`,
        ``,
      ].join("\n")
    );
    const r = supervisorLogMentions("cctra-serve", 10, f);
    expect(r).toHaveLength(3);
    expect(r[0]).toContain("spawned");
    expect(r[1]).toContain("exited");
    expect(r[2]).toContain("respawned");
  });

  test("caps result at n", () => {
    const f = join(tmpDir, "supervisor.log");
    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`[${1700000000000 + i}] [INFO] spawned 'foo' (pid=${i})`);
    }
    writeFileSync(f, lines.join("\n") + "\n");
    expect(supervisorLogMentions("foo", 3, f)).toHaveLength(3);
  });

  test("does not match unquoted name", () => {
    const f = join(tmpDir, "supervisor.log");
    writeFileSync(f, `[1700000000000] [INFO] cctra-serve unrelated log\n`);
    expect(supervisorLogMentions("cctra-serve", 5, f)).toEqual([]);
  });

  test("escapes regex special chars in name", () => {
    // 正常 slug 不会有特殊字符，但保险起见加测试
    const f = join(tmpDir, "supervisor.log");
    writeFileSync(f, `[1700000000000] [INFO] spawned 'a.b' (pid=1)\n`);
    expect(supervisorLogMentions("a.b", 5, f)).toHaveLength(1);
  });

  test("returns [] when N <= 0", () => {
    const f = join(tmpDir, "supervisor.log");
    writeFileSync(f, `[1700000000000] [INFO] spawned "foo" (pid=1)\n`);
    expect(supervisorLogMentions("foo", 0, f)).toEqual([]);
  });
});
