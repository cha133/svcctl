import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { xdgConfigHome, xdgDataHome, xdgStateHome } from "./xdg";

/** ~/.config/svcctl/entries.toml 路径 */
export function entriesTomlPath(): string {
  return join(xdgConfigHome(), "svcctl", "entries.toml");
}

/** ~/.config/svcctl/config.toml 路径 */
export function configTomlPath(): string {
  return join(xdgConfigHome(), "svcctl", "config.toml");
}

/** ~/.local/state/svcctl/logs 目录 */
export function logsDir(): string {
  return join(xdgStateHome(), "svcctl", "logs");
}

/** ~/.local/state/svcctl/logs/<name>.log 路径 */
export function logPath(name: string): string {
  return join(logsDir(), `${name}.log`);
}

/** ~/.local/state/svcctl/supervisor.log 路径（supervisor 自身日志） */
export function supervisorLogPath(): string {
  return join(xdgStateHome(), "svcctl", "supervisor.log");
}

/** ~/.local/state/svcctl/supervisor.pid 路径 */
export function supervisorPidPath(): string {
  return join(xdgStateHome(), "svcctl", "supervisor.pid");
}

/** ~/.local/state/svcctl/children.json 路径（Windows 用） */
export function childrenJsonPath(): string {
  return join(xdgStateHome(), "svcctl", "children.json");
}

/** ~/.local/state/svcctl/installed.flag 路径（首次 add 后写） */
export function installedFlagPath(): string {
  return join(xdgStateHome(), "svcctl", "installed.flag");
}

/** ~/.local/state/svcctl/control.json 路径（CLI ↔ supervisor IPC） */
export function controlJsonPath(): string {
  return join(xdgStateHome(), "svcctl", "control.json");
}

/**
 * Windows: ~/.local/share/svcctl/bin/SvcCtl.exe
 *
 * 放 XDG_DATA_HOME 下、不在 $PATH 上——绝不放 ~/.local/bin（Linux freedesktop 里这个
 * dir 在 PATH，会污染命令命名空间）。supervisor 升级时由 install/windows.ts 走
 * stop → copyFileSync → start 路径替换（svcctl v0.4.13 修过 NTFS lock）。
 *
 * v0.5.4: HKCU\Run 直接注册这个 .exe（删了 v0.5.2-v0.5.3 那个 XDG env wrapper .cmd）。
 * 路径写死在 Rust supervisor 的 locate_svcctl_paths() Windows 分支里，boot 启动时
 * 没有 env 也能写到正确的 XDG 风格目录。
 */
export function windowsSupervisorPath(): string {
  return join(xdgDataHome(), "svcctl", "bin", "SvcCtl.exe");
}

/** 确保目录存在 */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 确保 ~/.config/svcctl 存在 */
export function ensureSvcctlDir(): void {
  ensureDir(join(xdgConfigHome(), "svcctl"));
}

/** 确保 logs/ 存在 */
export function ensureLogsDir(): void {
  ensureDir(logsDir());
}

/** 确保 ~/.local/state/svcctl 存在（installed.flag / supervisor.pid / control.json 等的家） */
export function ensureStateDir(): void {
  ensureDir(join(xdgStateHome(), "svcctl"));
}
