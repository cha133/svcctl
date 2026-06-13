/**
 * svcctl enable <name> — 启用开机自启
 *
 * 对标 systemctl enable：修改 entries.toml 中对应 entry 的 startup 字段，
 * supervisor 通过 hot-reload 自动响应（startup false→true 时 spawn）。
 */
import { findEntry, EntryNotFoundError, EntryAmbiguousError } from "../entries/match";
import { loadEntries, saveEntries } from "../entries/store";
import { success, error } from "../format";
import { ensureSupervisorUpToDate, warnSupervisorOutdated, getInstalledSupervisorVersion } from "./helpers";
import type { Command } from "commander";

export async function enableCommand(name: string): Promise<void> {
  const resolved = findEntry(name);

  // supervisor 运行中但版本过旧 → 警告（需要 supervisor 热加载 startup 变化）
  const status = await ensureSupervisorUpToDate();
  if (status === "needs-restart") {
    warnSupervisorOutdated(getInstalledSupervisorVersion());
  }

  const file = loadEntries();
  const entry = file.entries.find((e) => e.name === resolved.name)!;

  // startup: true 是默认值，删字段即可还原
  delete entry.startup;
  saveEntries(file);
  success(`enabled auto-start for "${resolved.name}"`);
}

export function register(program: Command): void {
  program
    .command("enable <name>")
    .description("Enable auto-start at boot for an entry")
    .action(async (name: string) => {
      try {
        await enableCommand(name);
      } catch (e) {
        if (e instanceof EntryNotFoundError || e instanceof EntryAmbiguousError) {
          error(e.message);
          process.exit(1);
        }
        throw e;
      }
    });
}
