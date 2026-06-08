/**
 * svcctl stop — 停 supervisor（Windows 还要杀孤儿 children）
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { supervisorPidPath, childrenJsonPath } from "../paths";
import { success, error, info } from "../format";

const STOP_TIMEOUT_MS = 5000;

export async function stopCommand(): Promise<void> {
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

  // 等待 supervisor.pid 消失
  await waitForSupervisorExit();
  success("stopped.");
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

  // 1. 杀 children（从 children.json 读）
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

  // 2. 杀 supervisor
  try {
    execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe" });
    info(`killed supervisor (pid=${pid})`);
  } catch (e) {
    info(`supervisor (pid=${pid}) not killable: ${(e as Error).message}`);
  }

  // 3. 删 pid 文件
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
  // 超时不强报错（supervisor 可能写得慢）
}
