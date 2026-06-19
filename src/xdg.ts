import { join } from "node:path";
import { homedir } from "node:os";

/**
 * 解析一个 XDG 根目录：$XDG_*_HOME 如果非空就用，否则用 homedir() 拼 Linux 风格 fallback。
 *
 * 注：XDG 标准在 Windows 上 fallback 是 %APPDATA% / %LOCALAPPDATA%。但 svcctl 选「两个
 * 平台都用 Linux 风格路径」——homedir() 在 Windows 上是 %USERPROFILE%，所以结果就是
 * C:\Users\<u>\.config 等。和 Linux 上 ~/.config 行为一致。
 */
function xdgHome(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  if (v && v.length > 0) return v;
  return join(homedir(), fallback);
}

/** ~/.config — 用户可编辑的配置 */
export function xdgConfigHome(): string {
  return xdgHome("XDG_CONFIG_HOME", ".config");
}

/** ~/.local/share — 用户专属数据（包括装到本地的二进制如 SvcCtl.exe） */
export function xdgDataHome(): string {
  return xdgHome("XDG_DATA_HOME", join(".local", "share"));
}

/** ~/.local/state — 运行时状态（pid、log、IPC、child 列表、installed.flag） */
export function xdgStateHome(): string {
  return xdgHome("XDG_STATE_HOME", join(".local", "state"));
}

/** ~/.cache — 可重新生成的缓存 */
export function xdgCacheHome(): string {
  return xdgHome("XDG_CACHE_HOME", ".cache");
}
