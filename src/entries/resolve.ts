/**
 * v0.5.7: 注册时把裸命令名解析成绝对路径（按 PATH + PATHEXT 语义）。
 *
 * 背景（Windows bug）：supervisor 是 Rust 程序，`Command::new("dsh")` 走 CreateProcessW，
 * 只自动补 .exe、**不查 PATHEXT**，npm/scoop 的 `.cmd` shim 会 spawn 失败
 * （"program not found"）。JS 端 Node spawn（libuv）有 PATHEXT 语义所以没这问题。
 * 在 add 时解析成绝对路径，supervisor 拿到 `C:\...\dsh.cmd`，再由 Rust 端对
 * .cmd/.bat 走 `cmd.exe /d /s /c` 包装（CreateProcessW 不能直接执行批处理）。
 *
 * 规则：
 *   - command 含路径分隔符（/ 或 \）→ 用户已显式给路径，不解析（return null）
 *   - Windows 裸名：逐 PATH 目录按 PATHEXT 顺序尝试；**跳过无扩展名文件**
 *     （scoop/npm 的无扩展名 bash shim CreateProcess 执行不了，必须匹配到
 *     PATHEXT 内的扩展，如 dsh.cmd）
 *   - Unix 裸名：逐 PATH 目录查可执行位（X_OK）
 *   - 找不到 → return null（caller 保留原样，维持旧行为）
 */
import { accessSync, constants, readdirSync } from "node:fs";
import { join, delimiter } from "node:path";

export interface ResolveEnv {
  /** 测试注入用；默认 process.env.PATH */
  path?: string;
  /** 测试注入用；默认 process.env.PATHEXT */
  pathext?: string;
  /** 测试注入用；默认 process.platform */
  platform?: NodeJS.Platform;
}

const DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

/**
 * 解析裸命令名 → 绝对路径。不需要/找不到解析时返回 null。
 */
export function resolveCommand(command: string, env: ResolveEnv = {}): string | null {
  // 显式路径不解析
  if (/[/\\]/.test(command)) return null;

  const platform = env.platform ?? process.platform;
  const pathVar = env.path ?? process.env.PATH ?? "";
  const dirs = pathVar.split(delimiter).filter((d) => d.length > 0);

  if (platform === "win32") {
    const pathext = (env.pathext ?? process.env.PATHEXT ?? DEFAULT_PATHEXT.join(";"))
      .split(";")
      .map((e) => e.trim().toUpperCase())
      .filter((e) => e.length > 0);

    // 已带扩展名（如 "foo.exe"）：扩展必须在 PATHEXT 内，按原名找
    const dot = command.lastIndexOf(".");
    if (dot > 0) {
      const ext = command.slice(dot).toUpperCase();
      if (!pathext.includes(ext)) return null;
      for (const dir of dirs) {
        const real = matchCaseInsensitive(dir, command);
        if (real) return real;
      }
      return null;
    }

    // 裸名：目录优先，目录内按 PATHEXT 顺序。
    // 用 readdir 拿磁盘真实文件名（保留真实大小写）——不能直接拼 PATHEXT 的
    // 大写扩展名，否则存进 entries.toml 的是 "dsh.CMD" 这种失真路径。
    for (const dir of dirs) {
      for (const ext of pathext) {
        const real = matchCaseInsensitive(dir, command + ext);
        if (real) return real;
      }
    }
    return null;
  }

  // Unix / macOS：查可执行位
  for (const dir of dirs) {
    const cand = join(dir, command);
    try {
      accessSync(cand, constants.X_OK);
      return cand;
    } catch {
      // 不存在或不可执行，下一个目录
    }
  }
  return null;
}

/** 在 dir 里大小写不敏感地匹配 filename，返回保留磁盘真实大小写的完整路径 */
function matchCaseInsensitive(dir: string, filename: string): string | null {
  let listing: string[];
  try {
    listing = readdirSync(dir);
  } catch {
    return null;
  }
  const lower = filename.toLowerCase();
  for (const f of listing) {
    if (f.toLowerCase() === lower) return join(dir, f);
  }
  return null;
}
