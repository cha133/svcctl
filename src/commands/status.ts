/**
 * svcctl status — 3 级状态：installed / supervisor / per-entry
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInstalled } from "../install";
import { listEntries } from "../entries/store";
import { logPath, supervisorPidPath, supervisorLogPath, svcctlDir } from "../paths";
import { green, red, dim, error, info } from "../format";

const PID_ALIVE_TIMEOUT_SEC = 5;

export function statusCommand(): void {
  const installed = isInstalled();
  const supPid = readSupervisorPid();
  const supRunning = isPidAlive(supPid);
  const entries = listEntries();

  console.log(`svcctl ${dim(`(${svcctlDir()})`)}`);
  console.log(`  ${kv("installed", installed ? green("yes") : red("no"))}`);

  if (installed) {
    console.log(`  ${kv("supervisor", supRunning ? green(`running (pid=${supPid})`) : red("stopped"))}`);
    if (supRunning && existsSync(supervisorLogPath())) {
      const stat = statSync(supervisorLogPath());
      console.log(`    ${dim(`log: ${supervisorLogPath()} (${(stat.size / 1024).toFixed(1)} KB)`)}`);
    }
  }

  if (entries.length === 0) {
    console.log(`  ${dim("no entries registered.")}`);
    return;
  }

  console.log(`  ${kv(`entries (${entries.length})`, "")}`);
  for (const e of entries) {
    const status = entryStatus(e.name);
    const pid = entryPid(e.name);
    const line = `    ${status === "running" ? green("✓") : red("✗")} ${e.name.padEnd(20)} ${dim("→")} ${e.command} ${e.args.join(" ")}${pid ? dim(` (pid=${pid})`) : ""}`;
    console.log(line);
  }

  if (!installed) {
    console.log();
    error("not installed. Run `svcctl add <command>` to auto-install and add an entry.");
  } else if (!supRunning) {
    console.log();
    info("supervisor not running. Run `svcctl start` to start it (or reboot to autostart).");
  }
}

function kv(k: string, v: string): string {
  return `${k.padEnd(14)}${v}`;
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

function entryStatus(name: string): "running" | "stopped" | "never" {
  const p = logPath(name);
  if (!existsSync(p)) return "never";
  try {
    const ageSec = (Date.now() - statSync(p).mtimeMs) / 1000;
    return ageSec < PID_ALIVE_TIMEOUT_SEC * 12 /* 60s */ ? "running" : "stopped";
  } catch {
    return "never";
  }
}

function entryPid(name: string): number | null {
  // Windows: 读 children.json
  // macOS/Linux: pgrep（暂时省略，TODO 后续补）
  if (process.platform !== "win32") return null;
  const childrenFile = join(svcctlDir(), "children.json");
  if (!existsSync(childrenFile)) return null;
  try {
    const data = JSON.parse(readFileSync(childrenFile, "utf-8")) as Record<string, number>;
    return data[name] ?? null;
  } catch {
    return null;
  }
}
