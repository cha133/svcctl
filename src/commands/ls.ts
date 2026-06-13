/**
 * svcctl ls — 列已注册 entries（静态注册列表）
 * 区别：svcctl status 查运行时状态，svcctl ls 查静态注册列表
 */
import { listEntries } from "../entries/store";
import { entryState } from "../entries/match";
import { dim, green, red, yellow } from "../format";
import type { Command } from "commander";

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
    const state = entryState(e.name);
    const status =
      state === "running" ? green("running") : state === "stopped" ? red("stopped") : yellow("never");
    const added = new Date(e.createdAt).toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `${e.name.padEnd(nameW)}  ${e.command.padEnd(cmdW)}  ${argsStr}  ${status.padEnd(10)}  ${added}`
    );
  }
}

/** commander 注册：`svcctl ls`，alias `list` */
export function register(program: Command): void {
  program
    .command("ls")
    .alias("list")
    .description("List all registered entries")
    .action(() => {
      lsCommand();
    });
}
