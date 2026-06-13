/**
 * 多个 command 共享的小帮手
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { supervisorPidPath, controlJsonPath, supervisorVersionPath } from "../paths";
import { upgradeWindowsSupervisor, currentVersion } from "../install/windows";
import { defaultWindowsSupervisorPath } from "../install";
import { warn } from "../format";

/** 检查 supervisor 是否在跑（PID 文件存在 + 进程存活） */
export function isSupervisorRunning(): boolean {
  const p = supervisorPidPath();
  if (!existsSync(p)) return false;
  try {
    const pid = parseInt(readFileSync(p, "utf-8").trim(), 10);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 向 supervisor 发送 control 命令（写入 control.json） */
export function sendControlCommand(action: "start" | "stop" | "restart", name: string): void {
  const path = controlJsonPath();
  // 清理可能残留的旧 control.json（supervisor 旧版不处理会残留）
  if (existsSync(path)) {
    try { unlinkSync(path); } catch {}
  }
  writeFileSync(path, JSON.stringify({ action, name, ts: Date.now() }), "utf-8");
}

/** 等待 supervisor 处理 control.json（轮询文件被删，表示已处理） */
export async function waitForControlProcessed(timeoutMs = 5000): Promise<boolean> {
  const path = controlJsonPath();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export type SupervisorVersionStatus = "up-to-date" | "upgraded" | "needs-restart";

/**
 * 读取已安装的 supervisor 版本号（从 supervisor.version 文件）。
 * 文件不存在/读失败/内容为空 → 返回 null。
 */
export function getInstalledSupervisorVersion(): string | null {
  const p = supervisorVersionPath();
  if (!existsSync(p)) return null;
  try {
    const v = readFileSync(p, "utf-8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * 确保 supervisor 二进制是最新版本。
 *
 * - macOS/Linux：Node.js supervisor 始终用最新代码，直接返回 "up-to-date"
 * - Windows：对比版本文件与当前 CLI 版本，不匹配时自动复制新二进制
 *
 * 返回：
 *   "up-to-date"     — 版本一致
 *   "upgraded"       — 已自动升级二进制
 *   "needs-restart"  — supervisor 运行中，新版已就位但需重启
 */
export async function ensureSupervisorUpToDate(): Promise<SupervisorVersionStatus> {
  if (process.platform !== "win32") return "up-to-date";
  const bundled = defaultWindowsSupervisorPath();
  return await upgradeWindowsSupervisor(bundled);
}

/** supervisor 版本过旧时的标准警告消息 */
export function warnSupervisorOutdated(installedVer: string | null): void {
  const current = currentVersion();
  const verHint = installedVer ? `v${installedVer}` : "an older version";
  warn(
    `Supervisor ${verHint} is running, current is v${current}. Restart to apply upgrade.\n` +
    `  svcctl stop && svcctl start`
  );
}
