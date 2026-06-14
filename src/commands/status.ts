/**
 * svcctl status [name]
 *
 * - 无参：全局 installed / supervisor / per-entry 概览 + supervisor.log 末 5 行
 * - <name>：单服务详情（command/args/cwd/env/created/healthcheck/state/pid）
 *          + entry log 末 20 行 + supervisor.log 提到此 name 的 5 行
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  entryState,
  entryPid,
  tailLines,
  supervisorLogMentions,
  findEntry,
  ENTRY_LOG_TAIL_LINES,
  SUPERVISOR_LOG_TAIL_LINES,
  EntryNotFoundError,
  EntryAmbiguousError,
  type EntryState,
} from "../entries/match";
import { listEntries } from "../entries/store";
import {
  isInstalled,
} from "../install";
import { logPath, supervisorLogPath, supervisorPidPath, svcctlDir } from "../paths";
import { bold, dim, error, green, info, kvRow, red, yellow } from "../format";
import { ensureSupervisorUpToDate, warnSupervisorOutdated, getInstalledSupervisorVersion } from "./helpers";
import type { Command } from "commander";

export async function statusCommand(name?: string): Promise<void> {
  if (name) {
    await statusEntry(name);
  } else {
    statusGlobal();
  }
}

async function statusEntry(query: string): Promise<void> {
  let entry;
  try {
    entry = findEntry(query);
  } catch (e) {
    if (e instanceof EntryNotFoundError || e instanceof EntryAmbiguousError) {
      error(e.message);
      process.exit(1);
    }
    throw e;
  }

  // supervisor 运行中但版本过旧 → 警告
  const status = await ensureSupervisorUpToDate();
  if (status === "needs-restart") {
    warnSupervisorOutdated(getInstalledSupervisorVersion());
  }

  // 1) 头部 + 静态信息
  console.log(bold(`● ${entry.name}`));
  console.log(kvRow("command", entry.command));
  console.log(kvRow("args", entry.args.length ? entry.args.join(" ") : dim("(none)")));
  console.log(kvRow("cwd", entry.cwd ?? dim("(default)")));
  if (entry.env && Object.keys(entry.env).length) {
    for (const [k, v] of Object.entries(entry.env)) {
      console.log(kvRow(`env.${k}`, v));
    }
  }
  console.log(kvRow("created", entry.createdAt));
  console.log(kvRow("startup", entry.startup === false ? yellow("manual") : dim("auto (boot)")));
  // v0.4.7: opt-in auto-restart 状态
  console.log(kvRow("restart", entry.restart === true ? green("yes (opt-in)") : dim("no")));
  if (entry.healthcheckUrl) {
    console.log(kvRow("healthcheck", entry.healthcheckUrl));
  }

  // 2) 运行时状态
  const state = entryState(entry.name);
  const pid = entryPid(entry.name);
  const stateStr = stateBadge(state);
  console.log(
    kvRow("state", stateStr) + (pid !== null ? dim(` (pid=${pid})`) : "")
  );

  // 3) 该 entry 的 log 末尾
  const lp = logPath(entry.name);
  console.log();
  if (!existsSync(lp)) {
    info(`no log file yet at ${lp} (entry never spawned).`);
  } else {
    const lines = tailLines(lp, ENTRY_LOG_TAIL_LINES);
    console.log(dim(`── last ${lines.length} lines of ${lp} ──`));
    for (const l of lines) console.log(`  ${l}`);
  }

  // 4) supervisor.log 里提到此 name 的行（spawn 失败 / exited 诊断）
  const mentions = supervisorLogMentions(entry.name, 5);
  if (mentions.length) {
    console.log();
    console.log(dim(`── supervisor.log mentions of "${entry.name}" ──`));
    for (const l of mentions) console.log(`  ${l}`);
  }

  // 5) 底部 hint（如果 supervisor 没在跑）
  if (!isInstalled()) {
    console.log();
    info(`supervisor not installed — entries won't auto-start. Run \`svcctl install\`.`);
  } else {
    const supPid = readSupervisorPid();
    if (!isPidAlive(supPid)) {
      console.log();
      info(`supervisor not running. Run \`svcctl start\` to start it.`);
    }
  }
}

function statusGlobal(): void {
  const installed = isInstalled();
  const supPid = readSupervisorPid();
  const supRunning = isPidAlive(supPid);
  const entries = listEntries();

  console.log(`svcctl ${dim(`(${svcctlDir()})`)}`);
  console.log(`  ${kvRow("installed", installed ? green("yes") : red("no"))}`);

  if (installed) {
    console.log(
      `  ${kvRow(
        "supervisor",
        supRunning ? green(`running (pid=${supPid})`) : red("stopped")
      )}`
    );
    if (supRunning && existsSync(supervisorLogPath())) {
      const stat = statSync(supervisorLogPath());
      console.log(
        `    ${dim(`log: ${supervisorLogPath()} (${(stat.size / 1024).toFixed(1)} KB)`)}`
      );
    }
  }

  if (entries.length === 0) {
    console.log(`  ${dim("no entries registered.")}`);
  } else {
    console.log(`  ${kvRow(`entries (${entries.length})`, "")}`);
    for (const e of entries) {
      const state = entryState(e.name);
      const pid = entryPid(e.name);
      const line =
        `    ${state === "running" ? green("✓") : red("✗")} ` +
        `${e.name.padEnd(20)} ` +
        `${dim("→")} ${e.command} ${e.args.join(" ")}` +
        (pid !== null ? dim(` (pid=${pid})`) : "");
      console.log(line);
    }
  }

  // 末尾：supervisor.log tail（关键诊断入口：auto-start 失败会写在这里）
  if (existsSync(supervisorLogPath())) {
    const lines = tailLines(supervisorLogPath(), SUPERVISOR_LOG_TAIL_LINES);
    if (lines.length) {
      console.log();
      console.log(
        dim(`── last ${lines.length} lines of ${supervisorLogPath()} ──`)
      );
      for (const l of lines) console.log(`  ${l}`);
    }
  }

  if (!installed) {
    console.log();
    error(
      "not installed. Run `svcctl add <command>` to auto-install and add an entry."
    );
  } else if (!supRunning) {
    console.log();
    info("supervisor not running. Run `svcctl start` to start it (or reboot to autostart).");
  }
}

function stateBadge(s: EntryState): string {
  return s === "running" ? green("running") : s === "stopped" ? red("stopped") : yellow("never");
}

function readSupervisorPid(): number | null {
  const p = supervisorPidPath();
  if (!existsSync(p)) return null;
  try {
    const pid = parseInt(readFileSync(p, "utf-8").trim(), 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** commander 注册：`svcctl status [name]` */
export function register(program: Command): void {
  program
    .command("status [name]")
    .description(
      "Show status (omit name for global summary; pass name for per-entry detail)"
    )
    .action(async (name?: string) => {
      await statusCommand(name);
    });
}
