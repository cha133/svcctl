/**
 * svcctl start — 立即启动 supervisor（不等 OS 启动触发）
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { windowsSupervisorPath, supervisorPidPath } from "../paths";
import { success, error, info } from "../format";
import { isInstalled } from "../install";

const START_TIMEOUT_MS = 5000;

export async function startCommand(): Promise<void> {
  if (!isInstalled()) {
    error("svcctl is not installed. Run `svcctl add <command>` (auto-installs) or `svcctl install` first.");
    process.exit(1);
  }

  // 如果 supervisor 已经在跑
  if (supervisorAlreadyRunning()) {
    info("supervisor is already running.");
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

  // 等待 supervisor 写 PID 文件
  await waitForSupervisorPid();
  success(`supervisor started.`);
}

function supervisorAlreadyRunning(): boolean {
  const p = supervisorPidPath();
  if (!existsSync(p)) return false;
  try {
    const pid = parseInt(readFileSync(p, "utf-8").trim(), 10);
    if (!pid) return false;
    // process.kill(pid, 0) 探测存活（不真发信号）
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startWindows(): void {
  const sup = windowsSupervisorPath();
  if (!existsSync(sup)) {
    error(`supervisor not found: ${sup}`);
    process.exit(1);
  }
  // spawn detached，supervisor 自身会 hide console（#![windows_subsystem = "windows"]）
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
      // 简单 sleep 让 supervisor 真正初始化
      await new Promise((r) => setTimeout(r, 200));
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  error(`supervisor did not write PID file within ${START_TIMEOUT_MS}ms`);
  error(`check ~/.svcctl/supervisor.log for errors`);
  process.exit(1);
}

// 导出供 install 命令用
export { defaultSvcctlCliPath };
function defaultSvcctlCliPath(): string {
  const url = import.meta.url;
  const path = fileURLToPath(url);
  if (path.includes(join("src", "index.ts")) || path.includes(join("src", "index.js"))) {
    return join(dirname(path), "..", "bin", "svcctl.js");
  }
  return path;
}
