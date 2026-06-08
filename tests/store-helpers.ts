/**
 * 测试专用的 store helpers —— 暴露 path-injectable 版本，
 * 避免污染 src/entries/store.ts 的 API。
 */
import { addEntry, removeEntry, loadEntriesAt, saveEntriesAt } from "../src/entries/store";
import type { Entry } from "../src/entries/types";

export { loadEntriesAt, saveEntriesAt };

export function addEntryAt(entry: Entry, path: string): void {
  // 复用 addEntry 但要先 hack 一下 path——简单做法：直接 loadEntriesAt + saveEntriesAt
  const file = loadEntriesAt(path);
  if (file.entries.some((e) => e.name === entry.name)) {
    throw new Error(`entry "${entry.name}" already exists; use \`svcctl remove ${entry.name}\` first or pick a different name`);
  }
  file.entries.push(entry);
  saveEntriesAt(file, path);
}

export function removeEntryAt(name: string, path: string): void {
  const file = loadEntriesAt(path);
  const idx = file.entries.findIndex((e) => e.name === name);
  if (idx === -1) {
    throw new Error(`entry "${name}" not found`);
  }
  file.entries.splice(idx, 1);
  saveEntriesAt(file, path);
}

// re-export to keep TS happy
export { addEntry, removeEntry };
