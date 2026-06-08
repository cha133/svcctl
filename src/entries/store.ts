import { parseTOML, stringifyTOML } from "confbox";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { entriesTomlPath, ensureSvcctlDir } from "../paths";
import { emptyEntriesFile, type Entry, type EntriesFile } from "./types";

/** 读 entries.toml（path 可注入，测试用）；不存在/空 → 默认空文件 */
export function loadEntriesAt(path: string = entriesTomlPath()): EntriesFile {
  if (!existsSync(path)) {
    return emptyEntriesFile();
  }
  try {
    const raw = readFileSync(path, "utf-8");
    if (raw.trim() === "") return emptyEntriesFile();
    const parsed = parseTOML(raw) as Partial<EntriesFile>;
    // 防御性：空 entries 字段也当空文件处理
    if (!parsed || !Array.isArray(parsed.entries)) return emptyEntriesFile();
    return {
      version: parsed.version ?? 1,
      entries: parsed.entries as Entry[],
    };
  } catch {
    // 解析失败：返回空文件，错误由上层决定怎么处理
    return emptyEntriesFile();
  }
}

/** 写 entries.toml（原子写：先写 tmp 再 rename） */
export function saveEntriesAt(file: EntriesFile, path: string = entriesTomlPath()): void {
  if (path === entriesTomlPath()) {
    ensureSvcctlDir();
  }
  mkdirSync(dirname(path), { recursive: true });
  // 原子写：写到 tmp 再 rename 覆盖
  const tmp = join(tmpdir(), `svcctl-entries-${process.pid}-${Date.now()}.toml`);
  writeFileSync(tmp, stringifyTOML(file), "utf-8");
  renameSync(tmp, path);
}

/** 读 ~/.svcctl/entries.toml（默认路径） */
export function loadEntries(): EntriesFile {
  return loadEntriesAt(entriesTomlPath());
}

/** 写 ~/.svcctl/entries.toml（默认路径，原子写） */
export function saveEntries(file: EntriesFile): void {
  saveEntriesAt(file, entriesTomlPath());
}

/** 加一条 entry。重名抛错。 */
export function addEntry(entry: Entry): EntriesFile {
  const file = loadEntries();
  if (file.entries.some((e) => e.name === entry.name)) {
    throw new Error(`entry "${entry.name}" already exists; use \`svcctl remove ${entry.name}\` first or pick a different name`);
  }
  file.entries.push(entry);
  saveEntries(file);
  return file;
}

/** 删一条 entry。不存在抛错。 */
export function removeEntry(name: string): EntriesFile {
  const file = loadEntries();
  const idx = file.entries.findIndex((e) => e.name === name);
  if (idx === -1) {
    throw new Error(`entry "${name}" not found`);
  }
  file.entries.splice(idx, 1);
  saveEntries(file);
  return file;
}

/** 查一条 entry */
export function getEntry(name: string): Entry | undefined {
  return loadEntries().entries.find((e) => e.name === name);
}

/** 列所有 entries */
export function listEntries(): Entry[] {
  return loadEntries().entries;
}
