import { join } from "node:path";
import { homedir } from "node:os";

/**
 * v0.5.4: Windows 上路径定死从 homedir() 拼（= %USERPROFILE%/.local/state 等），
 * 不再读 XDG_*_HOME env、不再 fallback 到 %APPDATA%。跟 Rust supervisor
 * `locate_svcctl_paths()` 的 Windows 分支完全一致，避免跨进程路径错位。
 * Mac/Linux 保留 XDG env + homedir fallback。
 */
function xdgHome(envVar: string, fallback: string): string {
  if (process.platform === "win32") {
    return join(homedir(), fallback);
  }
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
