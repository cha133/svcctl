/**
 * svcctl restart <name> — 重启单个 entry
 *
 * 通过 control.json 向 supervisor 发送 restart 命令。
 * supervisor 会 kill 再重新 spawn 该 entry。
 */
import { findEntry, EntryNotFoundError, EntryAmbiguousError } from "../entries/match";
import { success, error } from "../format";
import { isSupervisorRunning, sendControlCommand, waitForControlProcessed, ensureSupervisorUpToDate, warnSupervisorOutdated, getInstalledSupervisorVersion } from "./helpers";
import type { Command } from "commander";

export async function restartCommand(name: string): Promise<void> {
  const resolved = findEntry(name);

  if (!isSupervisorRunning()) {
    error("supervisor is not running. Run `svcctl start` first.");
    process.exit(1);
  }

  // supervisor 运行中但版本过旧 → 警告
  const status = await ensureSupervisorUpToDate();
  if (status === "needs-restart") {
    warnSupervisorOutdated(getInstalledSupervisorVersion());
  }

  sendControlCommand("restart", resolved.name);
  const ok = await waitForControlProcessed();
  if (ok) {
    success(`restarted "${resolved.name}"`);
  } else {
    error(`timed out waiting for supervisor to process restart command`);
    process.exit(1);
  }
}

export function register(program: Command): void {
  program
    .command("restart <name>")
    .description("Restart a specific entry")
    .action(async (name: string) => {
      try {
        await restartCommand(name);
      } catch (e) {
        if (e instanceof EntryNotFoundError || e instanceof EntryAmbiguousError) {
          error(e.message);
          process.exit(1);
        }
        throw e;
      }
    });
}
