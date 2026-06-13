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
import { isSupervisorRunning, sendControlCommand, waitForControlProcessed, ensureSupervisorUpToDate, warnSupervisorOutdated, getInstalledSupervisorVersion } from "./helpers";
import type { Command } from "commander";

const STOP_TIMEOUT_MS = 5000;

export async function stopCommand(name?: string): Promise<void> {
  // 有 name → per-entry stop
  if (name) {
    await stopEntry(name);
    return;
  }

  // 无 name → 停止 supervisor
  const platform = process.platform;
  if (platform === "win32") {
    stopWindows();
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

  sendControlCommand("stop", resolved.name);
  const ok = await waitForControlProcessed();
  if (ok) {
    success(`stopped "${resolved.name}"`);
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

function stopWindows(): void {
  const pid = readSupervisorPid();
  if (!pid) {
    info("supervisor not running (no pid file).");
    return;
  }

  const childrenFile = childrenJsonPath();
  if (existsSync(childrenFile)) {
    try {
      const data = JSON.parse(readFileSync(childrenFile, "utf-8")) as Record<string, number>;
      for (const [name, childPid] of Object.entries(data)) {
        try {
          execSync(`taskkill /F /PID ${childPid}`, { stdio: "pipe" });
          info(`killed child "${name}" (pid=${childPid})`);
        } catch {
          // ignore
        }
      }
    } catch {}
  }

  try {
    execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe" });
    info(`killed supervisor (pid=${pid})`);
  } catch (e) {
    info(`supervisor (pid=${pid}) not killable: ${(e as Error).message}`);
  }

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
