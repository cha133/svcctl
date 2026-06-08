/**
 * 跨平台 detached child spawn（macOS / Linux 用；Windows 由 rust supervisor 负责）
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { Entry } from "../entries/types";

export interface SpawnOptions {
  entry: Entry;
  logPath: string;
}

export interface SpawnResult {
  proc: ChildProcess;
  stdoutStream: WriteStream;
  stderrStream: WriteStream;
}

/** 用 detached + stdio → log 文件的方式 spawn 一个 entry */
export function spawnDetached({ entry, logPath }: SpawnOptions): SpawnResult {
  // 确保 log 目录存在
  mkdirSync(dirname(logPath), { recursive: true });

  // 同一个 fd 同时给 stdout 和 stderr（append 模式）
  const outStream = createWriteStream(logPath, { flags: "a" });
  const errStream = createWriteStream(logPath, { flags: "a" });

  const proc = spawn(entry.command, entry.args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    env: { ...process.env, ...(entry.env ?? {}) },
  });

  // 把子进程 stdout/stderr 接到 log stream
  proc.stdout?.pipe(outStream);
  proc.stderr?.pipe(errStream);

  proc.unref();
  return { proc, stdoutStream: outStream, stderrStream: errStream };
}
