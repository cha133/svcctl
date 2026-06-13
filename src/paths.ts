import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

/** ~/.svcctl 根目录 */
export function svcctlDir(): string {
  return join(homedir(), ".svcctl");
}

/** ~/.svcctl/entries.toml 路径 */
export function entriesTomlPath(): string {
  return join(svcctlDir(), "entries.toml");
}

/** ~/.svcctl/config.toml 路径 */
export function configTomlPath(): string {
  return join(svcctlDir(), "config.toml");
}

/** ~/.svcctl/logs/ 目录 */
export function logsDir(): string {
  return join(svcctlDir(), "logs");
}

/** ~/.svcctl/logs/<name>.log 路径 */
export function logPath(name: string): string {
  return join(logsDir(), `${name}.log`);
}

/** ~/.svcctl/supervisor.log 路径（supervisor 自身日志） */
export function supervisorLogPath(): string {
  return join(svcctlDir(), "supervisor.log");
}

/** ~/.svcctl/supervisor.pid 路径 */
export function supervisorPidPath(): string {
  return join(svcctlDir(), "supervisor.pid");
}

/** ~/.svcctl/children.json 路径（Windows 用） */
export function childrenJsonPath(): string {
  return join(svcctlDir(), "children.json");
}

/** ~/.svcctl/installed.flag 路径（首次 add 后写） */
export function installedFlagPath(): string {
  return join(svcctlDir(), "installed.flag");
}

/** ~/.svcctl/control.json 路径（CLI ↔ supervisor IPC） */
export function controlJsonPath(): string {
  return join(svcctlDir(), "control.json");
}

/** ~/.svcctl/supervisor.version 路径（记录已安装 supervisor 二进制对应的 CLI 版本） */
export function supervisorVersionPath(): string {
  return join(svcctlDir(), "supervisor.version");
}

/** Windows: ~/.svcctl/bin/SvcCtl.exe */
export function windowsSupervisorPath(): string {
  return join(svcctlDir(), "bin", "SvcCtl.exe");
}

/** 确保目录存在 */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 确保 ~/.svcctl 存在 */
export function ensureSvcctlDir(): void {
  ensureDir(svcctlDir());
}

/** 确保 logs/ 存在 */
export function ensureLogsDir(): void {
  ensureDir(logsDir());
}
