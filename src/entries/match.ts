/**
 * 名称解析 + 共享 entry 状态判定
 *
 * - `findEntry` / `suggestEntries` —— fuzzy 解析 CLI 输入
 * - `entryState` / `entryPid` —— 替代 ls.ts/status.ts 两处重复的启发式
 *   （log.ts 有自己的 ad-hoc 桶策略，不走这里）
 * - `tailLines` / `supervisorLogMentions` —— 给 status 用 log tail
 *
 * 所有 path 都可选（默认从 ~/.svcctl 取），测试可注入 tmp dir。
 */
import { existsSync, readFileSync } from "node:fs";
import {
  childrenJsonPath,
  entriesTomlPath,
  logPath as defaultLogPath,
  supervisorLogPath as defaultSupervisorLogPath,
} from "../paths";
import { loadEntriesAt } from "./store";
import type { Entry } from "./types";

/** v0.4.2 引入的 60s 窗口历史值 —— entryState v0.4.8 起不再使用；保留以备 v1.1+ 复用 */
export const RUNNING_THRESHOLD_MS = 60_000;

/** status [name] tail 该 entry log 的行数 */
export const ENTRY_LOG_TAIL_LINES = 20;

/** status 全局 tail supervisor.log 的行数 */
export const SUPERVISOR_LOG_TAIL_LINES = 5;

/** supervisor.log 里扫 spawn 相关行的窗口（最近 N 行） */
export const SUPERVISOR_LOG_SCAN_LINES = 10_000;

export type EntryState = "running" | "stopped" | "never";

/** 错误：找不到任何候选 */
export class EntryNotFoundError extends Error {
  readonly query: string;
  readonly suggestions: string[];
  constructor(query: string, suggestions: string[]) {
    super(
      `no entry matches "${query}"${suggestions.length ? `. did you mean: ${suggestions.join(", ")}?` : ""}`
    );
    this.name = "EntryNotFoundError";
    this.query = query;
    this.suggestions = suggestions;
  }
}

/** 错误：多个候选（>1） */
export class EntryAmbiguousError extends Error {
  readonly query: string;
  readonly matches: string[];
  constructor(query: string, matches: string[]) {
    super(`ambiguous: "${query}" matches: ${matches.join(", ")}. use a more specific name.`);
    this.name = "EntryAmbiguousError";
    this.query = query;
    this.matches = matches;
  }
}

/**
 * 解析 CLI 输入的 entry 名 → Entry
 *
 * 策略（case-insensitive）：
 *   1. exact 匹配
 *   2. prefix 匹配
 *   3. substring 匹配
 * 每步：1 候选 → 命中；>1 候选 → EntryAmbiguousError；0 候选 → 走下一步。
 * 全部走完仍 0 → EntryNotFoundError + 最多 3 个建议。
 */
export function findEntry(query: string, path: string = entriesTomlPath()): Entry {
  const entries = loadEntriesAt(path).entries;
  if (entries.length === 0) {
    throw new EntryNotFoundError(query, []);
  }
  const q = query.toLowerCase();

  const exact = entries.filter((e) => e.name === q);
  if (exact.length === 1) return exact[0]!;

  const prefix = entries.filter((e) => e.name.startsWith(q));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) throw new EntryAmbiguousError(query, prefix.map((e) => e.name));

  const sub = entries.filter((e) => e.name.includes(q));
  if (sub.length === 1) return sub[0]!;
  if (sub.length > 1) throw new EntryAmbiguousError(query, sub.map((e) => e.name));

  throw new EntryNotFoundError(query, suggestEntries(query, 3, path).map((e) => e.name));
}

/**
 * "did you mean" 候选排序：prefix > substring > 更短名 > 更早 createdAt
 */
export function suggestEntries(
  query: string,
  limit: number = 3,
  path: string = entriesTomlPath()
): Entry[] {
  const q = query.toLowerCase();
  const entries = loadEntriesAt(path).entries;
  const scored = entries
    .map((e) => {
      const n = e.name;
      let score: number;
      if (n === q) score = 0;
      else if (n.startsWith(q)) score = 1;
      else if (n.includes(q)) score = 2;
      else return null;
      return { e, score, len: n.length };
    })
    .filter((x): x is { e: Entry; score: number; len: number } => x !== null)
    .sort(
      (a, b) =>
        a.score - b.score || a.len - b.len || a.e.createdAt.localeCompare(b.e.createdAt)
    );
  return scored.slice(0, limit).map((s) => s.e);
}

/**
 * 决定 entry 当前态：supervisor 是唯一权威
 *
 * - children.json 有 PID → `process.kill(pid, 0)` 探活；活 = running，否则 stopped
 * - children.json 没记录 → supervisor 没跟踪这个 entry（从未启动 / 已退出清理 /
 *   孤儿进程残留 —— supervisor 不知道这进程的 PID）。仅用 log 是否存在区分
 *   never vs stopped；**不再用 log mtime 判 running**
 *   （v0.4.2 那条启发式假设 "log 新鲜 = 进程活跃"，但孤儿进程可能仍在写 log，
 *    让 mtime 永久新鲜而 supervisor 完全不知情 —— v0.4.8 删掉这条误报路径）
 *
 * 替代 ls.ts:27 / status.ts:73 / status.ts:141 三处重复
 */
export function entryState(
  name: string,
  logPath: string = defaultLogPath(name),
  childrenPath: string = childrenJsonPath()
): EntryState {
  const pid = entryPid(name, childrenPath);
  if (pid !== null) {
    try {
      process.kill(pid, 0); // 信号 0 = 不真发信号，只检查 PID 是否存在（POSIX + Windows 同语义）
      return "running";
    } catch {
      return "stopped"; // supervisor 记过这个 entry，但进程已死
    }
  }
  // supervisor 没跟踪 → 仅用 log 是否存在区分 never / stopped。
  return existsSync(logPath) ? "stopped" : "never";
}

/** 跨平台从 children.json 读 PID（Node supervisor + Rust supervisor 都跨平台写） */
export function entryPid(
  name: string,
  childrenPath: string = childrenJsonPath()
): number | null {
  if (!existsSync(childrenPath)) return null;
  try {
    const data = JSON.parse(readFileSync(childrenPath, "utf-8")) as Record<string, number | null>;
    return data[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * 读文件最后 N 行
 * - 文件不存在 → []
 * - 去掉 split 产生的尾部空字符串（文件以 \n 结尾时）
 * 用 readFileSync + split，KB 级足够；TODO: 大文件流式 reverse-tail
 */
export function tailLines(filePath: string, n: number): string[] {
  if (n <= 0) return [];
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf-8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

/**
 * supervisor.log 里提到此 entry 名的行
 * Rust supervisor (`launcher/src/main.rs:122-149, 234`) 用单引号 `name`，
 * Node supervisor (`src/supervise/index.ts:122-149`) 也用单引号 `name`，
 * 唯一双引号出现在 supervisor 自己的 "supervisor started" 行（无关 entry）
 */
export function supervisorLogMentions(
  name: string,
  n: number = 5,
  path: string = defaultSupervisorLogPath()
): string[] {
  if (n <= 0) return [];
  if (!existsSync(path)) return [];
  // 扫最近 10k 行找匹配，再 cap 到 n
  const lines = tailLines(path, SUPERVISOR_LOG_SCAN_LINES);
  // 转义 name 防止 regex 注入（slug 都是 [a-z0-9-] 但还是保险）
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`'${escaped}'`);
  const matched: string[] = [];
  for (const l of lines) {
    if (re.test(l)) matched.push(l);
  }
  return matched.slice(-n);
}
