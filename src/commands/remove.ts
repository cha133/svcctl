/**
 * svcctl remove <name> [--all]
 */
import { removeEntry, loadEntries } from "../entries/store";
import { success, error, info } from "../format";
import type { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function removeCommand(name: string | undefined, opts: { all?: boolean }): Promise<void> {
  if (opts.all) {
    const all = loadEntries().entries;
    if (all.length === 0) {
      info("no entries to remove.");
      return;
    }
    // 简单 yes/no 提示（不引 @clack/prompts 避免多一个 dep）
    const rl = createInterface({ input, output });
    const answer = await rl.question(
      `Remove all ${all.length} entries? (OS supervisor stays installed) [y/N] `
    );
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      info("aborted.");
      return;
    }
    for (const e of all) {
      try {
        removeEntry(e.name);
        success(`removed "${e.name}"`);
      } catch (err) {
        error(`failed to remove "${e.name}": ${(err as Error).message}`);
      }
    }
    info(`removed ${all.length} entries.`);
    return;
  }

  if (!name) {
    error("Usage: svcctl remove <name> | --all");
    process.exit(1);
  }

  try {
    removeEntry(name);
    success(`removed "${name}"`);
    info(`supervisor will pick up the change automatically.`);
  } catch (e) {
    error((e as Error).message);
    process.exit(1);
  }
}

/** commander 注册：`svcctl remove [name] [--all]`，alias `rm` */
export function register(program: Command): void {
  program
    .command("remove [name]")
    .alias("rm")
    .description("Remove a registered entry (use --all to remove everything)")
    .option("-a, --all", "remove all entries")
    .action(async (name: string | undefined, opts: { all?: boolean }) => {
      await removeCommand(name, opts);
    });
}
