/**
 * svcctl start [name] — 启动 supervisor 或单个 entry
 *
 * 无参：启动 supervisor（现有行为，各平台 dispatch）
 * 有参：通过 control.json 告诉 supervisor 启动指定 entry
 */
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { windowsSupervisorPath, supervisorPidPath } from "../paths";
import { findEntry, EntryNotFoundError, EntryAmbiguousError } from "../entries/match";
import { success, error, info } from "../format";
import { isInstalled } from "../install";
import { isSupervisorRunning, sendControlCommand, waitForControlProcessed, ensureSupervisorUpToDate, warnSupervisorOutdated, getInstalledSupervisorVersion } from "./helpers";
import type { Command } from "commander";

const START_TIMEOUT_MS = 5000;

export async function startCommand(name?: string): Promise<void> {
  // 有 name → per-entry start
  if (name) {
    await startEntry(name);
    return;
  }

  // 无 name → 启动 supervisor
  if (!isInstalled()) {
    error("svcctl is not installed. Run `svcctl add <command>` (auto-installs) or `svcctl install` first.");
    process.exit(1);
  }

  // 启动前确保 supervisor 二进制是最新版
  const status = await ensureSupervisorUpToDate();
  if (status === "upgraded") {
    // 已自动升级，正常启动
  }

  if (isSupervisorRunning()) {
    if (status === "needs-restart") {
      warnSupervisorOutdated(getInstalledSupervisorVersion());
    } else {
      info("supervisor is already running.");
    }
    return;
  }

  const platform = process.platform;
  if (platform === "win32") {
    startWindows();
  } else if (platform === "darwin") {
    startMacOS();
  } else if (platform === "linux") {
    startLinux();
  } else {
    error(`unsupported platform: ${platform}`);
    process.exit(1);
  }

  await waitForSupervisorPid();
  success(`supervisor started.`);
}

async function startEntry(name: string): Promise<void> {
  const resolved = findEntry(name);

  if (!isSupervisorRunning()) {
    error("supervisor is not running. Run `svcctl start` first.");
    process.exit(1);
  }

  // supervisor 运行中但版本过旧 → 警告
  const status = await ensureSupervisorUpToDate();
  if (status === "needs-restart") {
    warnSupervisorOutdated(getInstalledSupervisorVersion());
  }

  sendControlCommand("start", resolved.name);
  const ok = await waitForControlProcessed();
  if (ok) {
    success(`started "${resolved.name}"`);
  } else {
    error(`timed out waiting for supervisor to process start command`);
    process.exit(1);
  }
}

function startWindows(): void {
  const sup = windowsSupervisorPath();
  if (!existsSync(sup)) {
    error(`supervisor not found: ${sup}`);
    process.exit(1);
  }
  const child = spawn(sup, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function startMacOS(): void {
  const uid = process.getuid?.() ?? execSync("id -u").toString().trim();
  const plist = join(homedir(), "Library", "LaunchAgents", "com.svcctl.supervisor.plist");
  try {
    execSync(`launchctl bootstrap gui/${uid} "${plist}"`, { stdio: "pipe" });
  } catch {
    // 已 loaded 不算错
  }
}

function startLinux(): void {
  try {
    execSync("systemctl --user start svcctl.service", { stdio: "pipe" });
  } catch (e) {
    error(`systemctl start failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function waitForSupervisorPid(): Promise<void> {
  const p = supervisorPidPath();
  const start = Date.now();
  while (Date.now() - start < START_TIMEOUT_MS) {
    if (existsSync(p)) {
      await new Promise((r) => setTimeout(r, 200));
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  error(`supervisor did not write PID file within ${START_TIMEOUT_MS}ms`);
  error(`check ~/.svcctl/supervisor.log for errors`);
  process.exit(1);
}

/** commander 注册：`svcctl start [name]` */
export function register(program: Command): void {
  program
    .command("start [name]")
    .description("Start the supervisor, or a specific entry if name is given")
    .action(async (name?: string) => {
      try {
        await startCommand(name);
      } catch (e) {
        if (e instanceof EntryNotFoundError || e instanceof EntryAmbiguousError) {
          error(e.message);
          process.exit(1);
        }
        throw e;
      }
    });
}
