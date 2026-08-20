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
  waitForEntryGone,
  checkSupervisorVersion,
  warnSupervisorOutdated,
  withStopCountdown,
} from "./helpers";
import type { Command } from "commander";

const STOP_TIMEOUT_MS = 5000;
// v0.4.9: 30s → 5s。要改直接改 launcher/src/main.rs:GRACE_PERIOD_MS + 这里同步
const GRACE_TIMEOUT_MS = 5000;

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

  // v0.4.11: outdated 时 warn（升级收口到 `svcctl upgrade`）
  if (await checkSupervisorVersion() === "outdated") {
    warnSupervisorOutdated();
  }

  // v0.4.4: 倒计时 + 用户 Enter 立即退
  // v0.4.9: 等的是 children.json 丢 entry（=supervisor 真 kill 完），不再等
  //         control.json 被删（IPC 来回 ~1s 不代表真杀完）
  const graceTimer = withStopCountdown(`stopping "${resolved.name}"`, GRACE_TIMEOUT_MS);
  sendControlCommand("stop", resolved.name);
  const result = await waitForEntryGone(resolved.name, GRACE_TIMEOUT_MS);
  graceTimer.clear();
  if (result === "gone") {
    success(`stopped "${resolved.name}"${graceTimer.aborted() ? " (skipped by user)" : ""}`);
  } else {
    error(`timed out after ${GRACE_TIMEOUT_MS / 1000}s waiting for "${resolved.name}" to stop — process may still be running`);
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
 * v0.5.9: 全局 stop 走 supervisor 的 "shutdown" IPC —— supervisor 收到后对每个 child
 * 依次做定向 Ctrl+Break + 5s grace + Job 兑底杀整棵树，全杀完自己退出（删 pid）。
 *
 * 旧路径（v0.4.4）有两个结构性问题：
 *   1. control.json 是单文件，给 N 个 entry 写 stop 会互相覆盖，只有最后一条生效
 *   2. 写完 IPC 立刻 taskkill /F，supervisor 每 1s 才轮询一次，grace 永远来不及
 *      生效，children 实际全是被 Job close 强杀的；没读到的 control.json 还会
 *      残留成幽灵命令（v0.5.8 已在 supervisor 启动时清理）
 *
 * 兼容：老 supervisor 不认识 shutdown（entry lookup 找不到空 name → 丢弃），
 * CLI 超时后 fallback taskkill /F（Job close 仍会带走整棵 child 树）。
 */
async function stopWindows(): Promise<void> {
  const pid = readSupervisorPid();
  if (!pid) {
    info("supervisor not running (no pid file).");
    return;
  }

  // 每个 running child 最多占 5s grace（顺序处理），+2s buffer，至少 5s
  let childCount = 0;
  if (existsSync(childrenJsonPath())) {
    try {
      childCount = Object.keys(
        JSON.parse(readFileSync(childrenJsonPath(), "utf-8")) as Record<string, number>
      ).length;
    } catch {}
  }
  const timeoutMs = Math.max(STOP_TIMEOUT_MS, childCount * GRACE_TIMEOUT_MS + 2000);

  sendControlCommand("shutdown", "");
  const graceTimer = withStopCountdown("stopping all entries", timeoutMs);
  const exited = await waitForSupervisorExit(timeoutMs);
  graceTimer.clear();

  if (!exited) {
    // 超时兑底：老 supervisor 不认识 shutdown / 卡死 → 强杀
    info("graceful shutdown timed out, force killing supervisor...");
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe" });
    } catch (e) {
      info(`supervisor (pid=${pid}) not killable: ${(e as Error).message}`);
    }
    try {
      unlinkSync(supervisorPidPath());
    } catch {}
  }
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

async function waitForSupervisorExit(timeoutMs: number = STOP_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(supervisorPidPath())) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
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
