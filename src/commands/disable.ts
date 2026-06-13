/**
 * svcctl disable <name> — 禁用开机自启（改为手动启动）
 *
 * 对标 systemctl disable：设 startup = false。
 * supervisor hot-reload 检测到 startup true→false 时会 kill 进程
 * （除非被 svcctl start <name> 手动启动过）。
 */
import { findEntry, EntryNotFoundError, EntryAmbiguousError } from "../entries/match";
import { loadEntries, saveEntries } from "../entries/store";
import { success, error } from "../format";
import { ensureSupervisorUpToDate, warnSupervisorOutdated, getInstalledSupervisorVersion } from "./helpers";
import type { Command } from "commander";

export async function disableCommand(name: string): Promise<void> {
  const resolved = findEntry(name);

  // supervisor 运行中但版本过旧 → 警告（需要 supervisor 热加载 startup 变化）
  const status = await ensureSupervisorUpToDate();
  if (status === "needs-restart") {
    warnSupervisorOutdated(getInstalledSupervisorVersion());
  }

  const file = loadEntries();
  const entry = file.entries.find((e) => e.name === resolved.name)!;

  entry.startup = false;
  saveEntries(file);
  success(`disabled auto-start for "${resolved.name}" (manual start only)`);
}

export function register(program: Command): void {
  program
    .command("disable <name>")
    .description("Disable auto-start at boot for an entry (manual start only)")
    .action(async (name: string) => {
      try {
        await disableCommand(name);
      } catch (e) {
        if (e instanceof EntryNotFoundError || e instanceof EntryAmbiguousError) {
          error(e.message);
          process.exit(1);
        }
        throw e;
      }
    });
}
