/**
 * svcctl ls — 列已注册 entries（静态注册列表）
 * 区别：svcctl status 查运行时状态，svcctl ls 查静态注册列表
 */
import { listEntries } from "../entries/store";
import { existsSync, statSync } from "node:fs";
import { logPath } from "../paths";
import { green, red, dim, yellow } from "../format";

export function lsCommand(): void {
  const entries = listEntries();
  if (entries.length === 0) {
    console.log("No entries registered. Use `svcctl add <command>` to add one.");
    return;
  }

  // header
  const nameW = Math.max(4, ...entries.map((e) => e.name.length));
  const cmdW = Math.max(7, ...entries.map((e) => e.command.length));
  console.log(
    `${"NAME".padEnd(nameW)}  ${"COMMAND".padEnd(cmdW)}  ${"ARGS".padEnd(20)}  ${"STATUS".padEnd(10)}  ADDED`
  );

  for (const e of entries) {
    const args = e.args.length === 0 ? dim("[]") : dim("[" + e.args.join(", ") + "]");
    const argsStr = args.length > 20 ? args.slice(0, 17) + "..." : args.padEnd(20);
    const status = entryStatus(e.name);
    const added = new Date(e.createdAt).toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `${e.name.padEnd(nameW)}  ${e.command.padEnd(cmdW)}  ${argsStr}  ${status.padEnd(10)}  ${added}`
    );
  }
}

/** 查 entry 状态：读 children.json（Windows），fallback 用 log mtime 60s 内 → running */
function entryStatus(name: string): string {
  const p = logPath(name);
  if (!existsSync(p)) return yellow("never");
  try {
    const mtime = statSync(p).mtimeMs;
    const ageSec = (Date.now() - mtime) / 1000;
    if (ageSec < 60) return green("running");
    return red("stopped");
  } catch {
    return dim("?");
  }
}
