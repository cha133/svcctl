/**
 * 多个 command 共享的小帮手
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { supervisorPidPath, controlJsonPath, childrenJsonPath, windowsSupervisorPath } from "../paths";
import { entryPid } from "../entries/match";
import { currentVersion } from "../install/windows";
import { readExeVersion, normalizeVersion } from "../install/exe-version";
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

/**
 * v0.4.9: 等 entry 从 children.json 消失 = supervisor 真删完 PID
 * （kill_tree_windows 跑完 + write_children_json 写完的间接信号）。
 * 之前 stop 走 waitForControlProcessed，只等 control.json 被删（IPC 来回 ~1s），
 * 但 grace 期间 children.json 是冻结的，CLI 提前 return 会让用户立刻 ls
 * 看到 "running" 误以为 stop 失败。现在等 children.json 真正反映 supervisor
 * 视角，CLI 跟 supervisor 同步。
 *
 * 边界 case：children.json 初始就没这个 entry（entry 从未跑过 / 已 stopped）→
 * 立即返回 "gone"（idempotent：再 stop 一次是 no-op，但用户视角仍合理）。
 */
export async function waitForEntryGone(
  name: string,
  timeoutMs: number,
  childrenPath: string = childrenJsonPath()
): Promise<"gone" | "timeout"> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (entryPid(name, childrenPath) === null) return "gone";
    await new Promise((r) => setTimeout(r, 100));
  }
  return "timeout";
}

export type SupervisorVersionStatus = "up-to-date" | "outdated";

/**
 * v0.4.11: 只 check supervisor version，不 upgrade。
 * 升级统一在 `svcctl upgrade` 命令里做（src/commands/upgrade.ts）。
 * 其他命令（start/install/stop）调这个，如果 outdated 就 warn 但不阻止。
 *
 * - macOS/Linux：Node.js supervisor 始终用最新代码，永远 up-to-date
 * - Windows：读 PE FileVersion 跟 currentVersion 对比
 */
export async function checkSupervisorVersion(): Promise<SupervisorVersionStatus> {
  if (process.platform !== "win32") return "up-to-date";
  const installed = readExeVersion(windowsSupervisorPath());
  if (!installed) return "outdated"; // 文件不存在
  return normalizeVersion(installed) === normalizeVersion(currentVersion())
    ? "up-to-date"
    : "outdated";
}

/** supervisor 版本过旧时的标准警告消息 */
export function warnSupervisorOutdated(): void {
  warn(`Supervisor is outdated. Run \`svcctl upgrade\` to update.`);
}

/**
 * v0.4.4: 在 stderr 上显示倒计时（清行 + 重写），并允许用户按 Enter 立即跳过。
 * `clear()` 终止显示并清行；返回的 `aborted()` 表示用户是否按 Enter 立即跳过。
 * non-tty / pipe 时不挂 readline（避免 `svcctl stop cctra | grep ...` 卡住）。
 */
export function withStopCountdown(
  label: string,
  timeoutMs = 30000
): { clear: () => void; aborted: () => boolean } {
  const start = Date.now();
  let stopped = false;
  let userAborted = false;
  const render = () => {
    if (stopped) return;
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const remain = Math.max(0, Math.ceil(timeoutMs / 1000) - elapsed);
    process.stderr.write(`\r\x1b[K⏳ ${label} (${remain}s, press Enter to skip)`);
  };
  render();
  const timer = setInterval(render, 250);
  // 用户按 Enter 立即跳过 —— 仅在 TTY 时挂监听（pipe/重定向时不动 stdin）
  let keypressHandler: ((ch: string, k: { name?: string }) => void) | null = null;
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin);
    if (process.stdin.setRawMode) process.stdin.setRawMode(true);
    keypressHandler = (_ch: string, k: { name?: string }) => {
      if (k.name === "return" || k.name === "enter") userAborted = true;
    };
    process.stdin.on("keypress", keypressHandler);
    process.stdin.resume();
  }
  return {
    clear: () => {
      stopped = true;
      clearInterval(timer);
      if (keypressHandler) {
        process.stdin.off("keypress", keypressHandler);
        if (process.stdin.setRawMode) process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      process.stderr.write(`\r\x1b[K`);
    },
    aborted: () => userAborted,
  };
}
