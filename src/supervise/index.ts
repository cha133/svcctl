/**
 * macOS / Linux 的长跑 supervisor（被 launchd / systemd 触发）
 *
 * 启动后：
 * 1. 写 ~/.svcctl/supervisor.pid
 * 2. 读 entries.toml → spawn startup:true 的 entry（跳过 startup:false 的手动 entry）
 * 3. fs.watch entries.toml → debounce 100ms → reconcile（kill 删掉的，spawn 新增的，响应 startup 变化）
 * 4. 每 1s：
 *    - processControlFile()  检查 CLI 通过 control.json 发来的 start/stop/restart 命令
 *    - reap 死掉的子进程（退避 1s 重启；跳过 pausedSet 里手动 stop 的）
 * 5. SIGTERM / SIGINT 清理：杀所有子进程 + 删 pid 文件
 */
import { watch } from "node:fs";
import { join } from "node:path";
import {
  svcctlDir,
  supervisorPidPath,
  logPath,
  childrenJsonPath,
  controlJsonPath,
} from "../paths";
import { loadEntries } from "../entries/store";
import { loadConfig } from "../config";
import { spawnDetached } from "./spawn";
import { logger } from "../logger";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import type { Entry } from "../entries/types";
import type { ChildProcess } from "node:child_process";

interface ChildRecord {
  proc: ChildProcess | null;
  lastSpawn: number;
  /** 当前 entry snapshot（命令改了的话 spawn 新进程） */
  entry: Entry;
}

const children = new Map<string, ChildRecord>();

/** 手动 stop 的 entry —— reap loop 不自动重启 */
const pausedSet = new Set<string>();
/** 手动 start 的 entry —— 即使 startup:false 也保持运行 */
const manualSet = new Set<string>();

// v0.4.4: 温柔 stop 等待时长。systemd=90s / supervisord=10s / docker=10s 折中选 30s
const GRACE_PERIOD_MS = 30_000;

/** v0.4.4: 温柔 + 兜底杀 `proc` 的整个 process group (POSIX)：
 *  1) kill(-pid, "SIGTERM") 信号整个 process group
 *  2) 轮询 30s 等 proc 自己退
 *  3) 兜底 kill(-pid, "SIGKILL") brutal
 *  失败 fallback 单 pid。
 */
function killTree(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid) { resolve(); return; }
    const pgid = -proc.pid;
    try { process.kill(pgid, "SIGTERM"); }
    catch { try { proc.kill("SIGTERM"); } catch {} }
    const start = Date.now();
    const poll = setInterval(() => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - start > GRACE_PERIOD_MS) {
        clearInterval(poll);
        try { process.kill(pgid, "SIGKILL"); }
        catch { try { proc.kill("SIGKILL"); } catch {} }
        resolve();
      }
    }, 100);
  });
}

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
  process.on("SIGHUP", () => { void reconcile(); });

  void reconcile();

  const entriesPath = join(dir, "entries.toml");
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    watch(entriesPath, { persistent: true }, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        logger.debug("entries.toml changed, reconciling");
        void reconcile();
      }, 100);
    });
    logger.info(`watching ${entriesPath}`);
  } catch (e) {
    logger.warn(`failed to watch entries.toml: ${(e as Error).message}`);
  }

  const config = loadConfig();
  const reapIntervalMs = config.reapIntervalMs;
  const backoffMs = config.restartBackoffMs;

  // v0.4.4: processControlFile / reconcile 现在 async，setInterval 用 mutex
  // 避免上一个 tick 没处理完下一个 tick 又来（stop/restart 命令并发会乱序）
  let processing = false;
  setInterval(() => {
    if (processing) return;
    processing = true;
    (async () => {
      try {
        // 1. 处理 CLI 通过 control.json 发来的命令
        await processControlFile();

        // 2. reap 死掉的子进程 + 退避重启
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
          // 跳过手动 stop 的 entry
          // v0.4.7: 加 rec.entry.restart 条件 —— opt-in 才在死后重启
          if (!rec.proc
              && rec.entry.restart
              && now - rec.lastSpawn >= backoffMs
              && !pausedSet.has(name)) {
            spawnChild(name, rec.entry);
          }
        }
      } finally {
        processing = false;
      }
    })();
  }, reapIntervalMs).unref();

  // 长跑 —— 用一个永不 resolve 的 promise
  await new Promise<void>(() => {});
}

/** 处理 control.json（CLI → supervisor IPC） */
async function processControlFile(): Promise<void> {
  const path = controlJsonPath();
  if (!existsSync(path)) return;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }

  let cmd: { action: string; name: string; ts: number };
  try {
    cmd = JSON.parse(raw);
  } catch {
    logger.warn("control: invalid JSON in control.json, removing");
    try { unlinkSync(path); } catch {}
    return;
  }

  // 读最新 entries 拿这个 entry 的 config
  const entries = loadEntries().entries;
  const entry = entries.find((e) => e.name === cmd.name);
  if (!entry) {
    logger.warn(`control: entry "${cmd.name}" not found`);
    try { unlinkSync(path); } catch {}
    return;
  }

  // v0.4.4: 先删 control.json 再做事 —— killTree 里 30s grace 等待
  // 不能阻塞 CLI 的 waitForControlProcessed（5s timeout）。
  try { unlinkSync(path); } catch {}

  switch (cmd.action) {
    case "start":
      manualSet.add(cmd.name);
      pausedSet.delete(cmd.name);
      {
        const rec = children.get(cmd.name);
        if (!rec) {
          // 新 entry —— 可能 startup:false 没在初始 reconcile 时 spawn
          const newRec: ChildRecord = { proc: null, lastSpawn: 0, entry };
          children.set(cmd.name, newRec);
          spawnChild(cmd.name, entry);
        } else if (!rec.proc || rec.proc.exitCode !== null || rec.proc.signalCode !== null) {
          spawnChild(cmd.name, entry);
        } else {
          logger.info(`"${cmd.name}" is already running`);
        }
      }
      writeChildrenJson();
      break;

    case "stop":
      pausedSet.add(cmd.name);
      manualSet.delete(cmd.name);
      {
        const rec = children.get(cmd.name);
        if (rec?.proc) {
          const proc = rec.proc;
          rec.proc = null;
          rec.lastSpawn = Date.now();
          writeChildrenJson();
          await killTree(proc);
          logger.info(`manually stopped "${cmd.name}"`);
        } else {
          logger.info(`"${cmd.name}" is not running`);
        }
      }
      break;

    case "restart":
      manualSet.add(cmd.name);
      pausedSet.delete(cmd.name);
      {
        const rec = children.get(cmd.name);
        if (rec?.proc) {
          const proc = rec.proc;
          rec.proc = null;
          rec.lastSpawn = Date.now();
          await killTree(proc);
        }
        spawnChild(cmd.name, entry);
        writeChildrenJson();
        logger.info(`restarted "${cmd.name}"`);
      }
      break;

    default:
      logger.warn(`control: unknown action "${cmd.action}"`);
  }

  // (control.json 已在 switch 前删除)
}

async function reconcile(): Promise<void> {
  const file = loadEntries();
  const newEntries = file.entries;
  const newNames = new Set(newEntries.map((e) => e.name));

  // 1. kill 删除的 entry（同时清理 paused/manual set）
  const toRemove: Array<[string, ChildRecord]> = [];
  for (const [name, rec] of children) {
    if (!newNames.has(name)) {
      toRemove.push([name, rec]);
    }
  }
  for (const [name, rec] of toRemove) {
    logger.info(`removing child "${name}" (no longer in entries.toml)`);
    if (rec.proc) {
      const proc = rec.proc;
      rec.proc = null;
      await killTree(proc);
    }
    children.delete(name);
    pausedSet.delete(name);
    manualSet.delete(name);
  }

  // 2. spawn 新增 / 更新现有的 entry
  for (const entry of newEntries) {
    const existing = children.get(entry.name);
    const shouldRun = entry.startup !== false || manualSet.has(entry.name);

    if (!existing) {
      // 新增 entry
      const rec: ChildRecord = { proc: null, lastSpawn: 0, entry };
      children.set(entry.name, rec);
      if (shouldRun && !pausedSet.has(entry.name)) {
        spawnChild(entry.name, entry);
      }
    } else {
      // 已存在的 entry —— 检查是否有变化
      const wasStartup = existing.entry.startup !== false;
      const isStartup = entry.startup !== false;
      const changed = entryChanged(existing.entry, entry);

      if (changed) {
        // command/args/cwd 变了 → 重启
        logger.info(`entry "${entry.name}" changed, restarting`);
        if (existing.proc) {
          const proc = existing.proc;
          existing.proc = null;
          await killTree(proc);
        }
        existing.lastSpawn = Date.now();
        existing.entry = entry;
        if (shouldRun && !pausedSet.has(entry.name)) {
          spawnChild(entry.name, entry);
        }
      } else if (wasStartup && !isStartup && !manualSet.has(entry.name)) {
        // startup true→false：kill（除非被手动 start 过）
        logger.info(`entry "${entry.name}" startup: true→false, stopping`);
        if (existing.proc) {
          const proc = existing.proc;
          existing.proc = null;
          existing.lastSpawn = Date.now();
          await killTree(proc);
        }
        existing.entry = entry;
      } else if (!wasStartup && isStartup && !pausedSet.has(entry.name)) {
        // startup false→true：spawn（除非被手动 stop 过）
        logger.info(`entry "${entry.name}" startup: false→true, starting`);
        spawnChild(entry.name, entry);
        existing.entry = entry;
      } else {
        // 没变化，更新 entry 引用（可能 startup 没变但其他字段如 createdAt 变了）
        existing.entry = entry;
      }
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
  // 防止重复 spawn（如果已经在跑就不要 double-spawn）
  const rec = children.get(name);
  if (rec?.proc && rec.proc.exitCode === null && rec.proc.signalCode === null) {
    return;
  }

  try {
    const { proc } = spawnDetached({ entry, logPath: logPath(name) });
    const rec2 = children.get(name);
    if (rec2) {
      rec2.proc = proc;
      rec2.lastSpawn = Date.now();
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
