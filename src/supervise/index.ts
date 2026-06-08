/**
 * macOS / Linux 的长跑 supervisor（被 launchd / systemd 触发）
 *
 * 启动后：
 * 1. 写 ~/.svcctl/supervisor.pid
 * 2. 读 entries.toml → spawn 所有 entry 的子进程（detached + stdio → log）
 * 3. fs.watch entries.toml → debounce 100ms → reconcile（kill 删掉的，spawn 新增的）
 * 4. setInterval 1s reap 死掉的子进程（退避 1s 重启）
 * 5. SIGTERM / SIGINT 清理：杀所有子进程 + 删 pid 文件
 */
import { watch } from "node:fs";
import { join } from "node:path";
import {
  svcctlDir,
  supervisorPidPath,
  logPath,
  childrenJsonPath,
} from "../paths";
import { loadEntries } from "../entries/store";
import { loadConfig } from "../config";
import { spawnDetached } from "./spawn";
import { logger } from "../logger";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import type { Entry } from "../entries/types";
import type { ChildProcess } from "node:child_process";

interface ChildRecord {
  proc: ChildProcess | null;
  lastSpawn: number;
  /** 当前 entry snapshot（命令改了的话 spawn 新进程） */
  entry: Entry;
}

const children = new Map<string, ChildRecord>();

export async function runSupervisor(): Promise<void> {
  const dir = svcctlDir();
  const pidPath = supervisorPidPath();
  writeFileSync(pidPath, String(process.pid));
  logger.info(`supervisor started (pid=${process.pid})`);

  const cleanup = (signal: string) => {
    logger.info(`received ${signal}, cleaning up`);
    for (const [, rec] of children) {
      if (rec.proc) {
        try {
          rec.proc.kill("SIGTERM");
        } catch {}
      }
    }
    try {
      unlinkSync(pidPath);
    } catch {}
    if (existsSync(childrenJsonPath())) {
      try {
        unlinkSync(childrenJsonPath());
      } catch {}
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGHUP", () => reconcile());

  reconcile();

  const entriesPath = join(dir, "entries.toml");
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    watch(entriesPath, { persistent: true }, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        logger.debug("entries.toml changed, reconciling");
        reconcile();
      }, 100);
    });
    logger.info(`watching ${entriesPath}`);
  } catch (e) {
    logger.warn(`failed to watch entries.toml: ${(e as Error).message}`);
  }

  const config = loadConfig();
  const reapIntervalMs = config.reapIntervalMs;
  const backoffMs = config.restartBackoffMs;

  setInterval(() => {
    const now = Date.now();
    for (const [name, rec] of children) {
      if (rec.proc && (rec.proc.exitCode !== null || rec.proc.signalCode !== null)) {
        logger.warn(
          `child "${name}" exited (code=${rec.proc.exitCode}, signal=${rec.proc.signalCode})`
        );
        rec.proc = null;
        rec.lastSpawn = now;
        writeChildrenJson();
      }
      if (!rec.proc && now - rec.lastSpawn >= backoffMs) {
        spawnChild(name, rec.entry);
      }
    }
  }, reapIntervalMs).unref();

  // 长跑 —— 用一个永不 resolve 的 promise
  await new Promise<void>(() => {});
}

function reconcile(): void {
  const file = loadEntries();
  const newEntries = file.entries;
  const newNames = new Set(newEntries.map((e) => e.name));

  // 1. kill 删除的
  for (const [name, rec] of children) {
    if (!newNames.has(name)) {
      logger.info(`removing child "${name}" (no longer in entries.toml)`);
      if (rec.proc) {
        try {
          rec.proc.kill("SIGTERM");
        } catch {}
      }
      children.delete(name);
    }
  }

  // 2. spawn 新增 / 更新现有的 entry
  for (const entry of newEntries) {
    const existing = children.get(entry.name);
    if (!existing) {
      // 新增
      const rec: ChildRecord = { proc: null, lastSpawn: 0, entry };
      children.set(entry.name, rec);
      spawnChild(entry.name, entry);
    } else if (entryChanged(existing.entry, entry)) {
      // entry 内容变了（command/args/cwd/env）→ 重启
      logger.info(`entry "${entry.name}" changed, restarting`);
      if (existing.proc) {
        try {
          existing.proc.kill("SIGTERM");
        } catch {}
      }
      existing.proc = null;
      existing.lastSpawn = Date.now();
      existing.entry = entry;
      spawnChild(entry.name, entry);
    } else {
      // entry 没变，更新 entry 引用
      existing.entry = entry;
    }
  }

  writeChildrenJson();
}

function entryChanged(a: Entry, b: Entry): boolean {
  if (a.command !== b.command) return true;
  if (a.args.length !== b.args.length) return true;
  for (let i = 0; i < a.args.length; i++) {
    if (a.args[i] !== b.args[i]) return true;
  }
  if (a.cwd !== b.cwd) return true;
  return false;
}

function spawnChild(name: string, entry: Entry): void {
  try {
    const { proc } = spawnDetached({ entry, logPath: logPath(name) });
    const rec = children.get(name);
    if (rec) {
      rec.proc = proc;
      rec.lastSpawn = Date.now();
    }
    logger.info(`spawned "${name}" (pid=${proc.pid})`);
    writeChildrenJson();
  } catch (e) {
    logger.error(`failed to spawn "${name}": ${(e as Error).message}`);
  }
}

function writeChildrenJson(): void {
  const data: Record<string, number | null> = {};
  for (const [name, rec] of children) {
    data[name] = rec.proc?.pid ?? null;
  }
  try {
    writeFileSync(childrenJsonPath(), JSON.stringify(data, null, 2), "utf-8");
  } catch {}
}
