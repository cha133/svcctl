/**
 * svcctl stop [name] — 停止 supervisor 或单个 entry
 *
 * 无参：停止 supervisor（现有行为，各平台 dispatch）
 * 有参：通过 control.json 告诉 supervisor 停止指定 entry
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { supervisorPidPath, childrenJsonPath } from "../paths";
import { findEntry, EntryNotFoundError, EntryAmbiguousError } from "../entries/match";
import { success, error, info } from "../format";
import {
  isSupervisorRunning,
  sendControlCommand,
  waitForControlProcessed,
  ensureSupervisorUpToDate,
  warnSupervisorOutdated,
  getInstalledSupervisorVersion,
  withStopCountdown,
} from "./helpers";
import type { Command } from "commander";

const STOP_TIMEOUT_MS = 5000;
const GRACE_TIMEOUT_MS = 30000;

export async function stopCommand(name?: string): Promise<void> {
  // 有 name → per-entry stop
  if (name) {
    await stopEntry(name);
    return;
  }

  // 无 name → 停止 supervisor
  const platform = process.platform;
  if (platform === "win32") {
    await stopWindows();
  } else if (platform === "darwin") {
    stopMacOS();
  } else if (platform === "linux") {
    stopLinux();
  } else {
    error(`unsupported platform: ${platform}`);
    process.exit(1);
  }

  await waitForSupervisorExit();
  success("stopped.");
}

async function stopEntry(name: string): Promise<void> {
  const resolved = findEntry(name);

  if (!isSupervisorRunning()) {
    error("supervisor is not running.");
    process.exit(1);
  }

  // supervisor 运行中但版本过旧 → 警告
  const status = await ensureSupervisorUpToDate();
  if (status === "needs-restart") {
    warnSupervisorOutdated(getInstalledSupervisorVersion());
  }

  // v0.4.4: 倒计时 + 用户 Enter 立即退
  const graceTimer = withStopCountdown(`stopping "${resolved.name}"`, GRACE_TIMEOUT_MS);
  sendControlCommand("stop", resolved.name);
  const ok = await waitForControlProcessed();
  graceTimer.clear();
  if (ok) {
    success(`stopped "${resolved.name}"${graceTimer.aborted() ? " (skipped by user)" : ""}`);
  } else {
    error(`timed out waiting for supervisor to process stop command`);
    process.exit(1);
  }
}

function readSupervisorPid(): number | null {
  const p = supervisorPidPath();
  if (!existsSync(p)) return null;
  try {
    const pid = parseInt(readFileSync(p, "utf-8").trim(), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * v0.4.4: 全局 stop 改为走 IPC 路径 —— 让 supervisor 走温柔 Ctrl+C + Job 兜底杀整棵树，
 * 避免 CLI 端 taskkill 漏 grandchild。
 * 等待 supervisor 自己退出（删 supervisor.pid 文件），最多 5s。
 */
async function stopWindows(): Promise<void> {
  const pid = readSupervisorPid();
  if (!pid) {
    info("supervisor not running (no pid file).");
    return;
  }

  // 发 stop IPC 给每个 entry（supervisor 收到后温柔 Ctrl+C + Job 兜底）
  const childrenFile = childrenJsonPath();
  if (existsSync(childrenFile)) {
    try {
      const data = JSON.parse(readFileSync(childrenFile, "utf-8")) as Record<string, number>;
      for (const name of Object.keys(data)) {
        sendControlCommand("stop", name);
      }
    } catch {}
  }

  // supervisor 收到 stop 后：
  // 1) 温柔 Ctrl+C 给所有 entry（30s 等待）
  // 2) Job 兜底关 handle → 杀整棵进程树
  // 3) supervisor 自己退出（删 supervisor.pid）
  // 我们等它退出即可
  try {
    execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe" });
    info(`sent supervisor (pid=${pid}) stop signal`);
  } catch (e) {
    info(`supervisor (pid=${pid}) not killable: ${(e as Error).message}`);
  }
  // 兜底 supervisor 自己（极端情况：supervisor 卡在 IPC 死循环）
  try {
    unlinkSync(supervisorPidPath());
  } catch {}
}

function stopMacOS(): void {
  const uid = process.getuid?.() ?? execSync("id -u").toString().trim();
  try {
    execSync(`launchctl bootout gui/${uid}/com.svcctl.supervisor`, { stdio: "pipe" });
  } catch {
    info("supervisor not loaded (already stopped).");
  }
}

function stopLinux(): void {
  try {
    execSync("systemctl --user stop svcctl.service", { stdio: "pipe" });
  } catch (e) {
    info(`systemctl stop failed: ${(e as Error).message}`);
  }
}

async function waitForSupervisorExit(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < STOP_TIMEOUT_MS) {
    if (!existsSync(supervisorPidPath())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** commander 注册：`svcctl stop [name]` */
export function register(program: Command): void {
  program
    .command("stop [name]")
    .description("Stop the supervisor, or a specific entry if name is given")
    .action(async (name?: string) => {
      try {
        await stopCommand(name);
      } catch (e) {
        if (e instanceof EntryNotFoundError || e instanceof EntryAmbiguousError) {
          error(e.message);
          process.exit(1);
        }
        throw e;
      }
    });
}
