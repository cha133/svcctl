import { join } from "node:path";
import { homedir } from "node:os";

/**
 * v0.5.5: 全平台路径从 homedir() 拼（= ~/.local/state 等），
 * 不读 SVCCTL_HOME / XDG_*_HOME env、不 fallback ~/.svcctl/。
 * 跟 Rust supervisor `locate_svcctl_paths()` 全平台行为一致，
 * 避免 CLI 跟 supervisor 路径错位。
 *
 * 函数名 `xdgHome` 保留作历史记号；实现上不再读 XDG。
 */
function xdgHome(fallback: string): string {
  return join(homedir(), fallback);
}

/** ~/.config — 用户可编辑的配置 */
export function xdgConfigHome(): string {
  return xdgHome(".config");
}

/** ~/.local/share — Windows-only (.exe 落点)；POSIX 不再读 XDG_DATA_HOME */
export function xdgDataHome(): string {
  return xdgHome(join(".local", "share"));
}

/** ~/.local/state — 运行时状态（pid、log、IPC、child 列表、installed.flag） */
export function xdgStateHome(): string {
  return xdgHome(join(".local", "state"));
}