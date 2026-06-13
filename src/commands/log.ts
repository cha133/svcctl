/**
 * svcctl log [<name>] [-f] [-n <lines>]
 *
 * - 无 name：列表模式（列所有 entries + log 文件状态）
 * - 有 name：
 *   - 无 -f：打整个 log，可选 -n 取最后 N 行
 *   - 有 -f：先打最后 N 行（默认 20）再 follow；显式 -n 0 跳过历史
 * 名字解析用 findEntry（fuzzy）；entry 存在但 log 未生成 → info() 不 error
 */
import { listEntries } from "../entries/store";
import { logPath, logsDir } from "../paths";
import {
  findEntry,
  tailLines,
  EntryNotFoundError,
  EntryAmbiguousError,
} from "../entries/match";
import { dim, error, green, info, red, yellow } from "../format";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";

/** -f 模式默认要打印的历史行数 */
const DEFAULT_FOLLOW_TAIL_LINES = 20;

export interface LogOptions {
  follow?: boolean;
  lines?: number;
}

export async function logCommand(
  name: string | undefined,
  opts: LogOptions
): Promise<void> {
  // 1. 无 name → 列表模式
  if (!name) {
    if (opts.follow) {
      error("`svcctl log -f` requires an entry name. Usage: svcctl log <name> -f");
      process.exit(1);
    }
    listLogs();
    return;
  }

  // 2. fuzzy 解析 name
  let entry;
  try {
    entry = findEntry(name);
  } catch (e) {
    if (e instanceof EntryNotFoundError || e instanceof EntryAmbiguousError) {
      error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const file = logPath(entry.name);
  if (!existsSync(file)) {
    info(
      `entry "${entry.name}" exists but has no log file yet (never spawned). check \`svcctl status\`.`
    );
    return;
  }

  // 3. 有 name + 无 -f → 一次性打
  if (!opts.follow) {
    const text = readFileSync(file, "utf-8");
    if (opts.lines && opts.lines > 0) {
      const lines = text.split("\n");
      const lastN = lines.slice(-opts.lines);
      process.stdout.write(lastN.join("\n") + (lastN.length > 0 ? "\n" : ""));
    } else {
      process.stdout.write(text);
    }
    return;
  }

  // 4. 有 name + -f → 跟随模式
  //    默认先打最后 20 行再 follow（`tail -f` 习惯）；
  //    显式 -n 0 保留老的"跳过历史"行为。
  const skipHistory = opts.lines === 0;
  const tailN = skipHistory ? 0 : (opts.lines ?? DEFAULT_FOLLOW_TAIL_LINES);

  if (skipHistory) {
    process.stdout.write(
      dim(`[following ${file}, skipping history (-n 0)]`) + "\n"
    );
  } else {
    const existing = tailLines(file, tailN);
    if (existing.length) {
      process.stdout.write(
        dim(`[showing last ${existing.length} lines of ${file}, then following]`) + "\n"
      );
      for (const l of existing) process.stdout.write(l + "\n");
    } else {
      process.stdout.write(dim(`[following ${file} (empty)]`) + "\n");
    }
  }
  process.stdout.write(dim("[press Ctrl-C to stop]") + "\n");

  // offset = 当前文件 size（tail 已显示的是历史；进入循环后写的新内容会被 stat 增长捕获）
  let offset = statSync(file).size;

  const interval = setInterval(() => {
    try {
      const stat = statSync(file);
      if (stat.size > offset) {
        const fd = readFileSync(file, { encoding: "utf-8", flag: "r" });
        process.stdout.write(fd.slice(offset));
        offset = stat.size;
      } else if (stat.size < offset) {
        // log 被 truncate 了，重置 offset
        offset = 0;
      }
    } catch (e) {
      process.stderr.write("[svcctl log] read error: " + (e as Error).message + "\n");
    }
  }, 500);

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      clearInterval(interval);
      process.stdout.write("\n");
      resolve();
    });
    process.on("SIGTERM", () => {
      clearInterval(interval);
      resolve();
    });
  });
}

function listLogs(): void {
  if (!existsSync(logsDir())) {
    info(`no log directory yet at ${logsDir()}`);
    return;
  }
  const files = readdirSync(logsDir()).filter((f) => f.endsWith(".log"));
  if (files.length === 0) {
    info(`no log files yet in ${logsDir()}`);
    return;
  }

  // 列所有 entries（不一定有 log 文件，但 entries 是更全的列表）
  const entries = listEntries();
  const entryNames = new Set(entries.map((e) => e.name));

  // 收集所有 log 文件名（可能有些 entry 没 log）
  const names = new Set<string>([
    ...entryNames,
    ...files.map((f) => f.replace(/\.log$/, "")),
  ]);

  console.log(
    `${"NAME".padEnd(20)}  ${"STATUS".padEnd(10)}  ${"LOG PATH".padEnd(50)}  SIZE      MODIFIED`
  );

  for (const n of [...names].sort()) {
    const p = join(logsDir(), `${n}.log`);
    if (!existsSync(p)) {
      console.log(`${n.padEnd(20)}  ${yellow("no log").padEnd(10)}  ${dim(p)}`);
      continue;
    }
    const stat = statSync(p);
    const ageSec = (Date.now() - stat.mtimeMs) / 1000;
    const status =
      ageSec < 60 ? green("running") : ageSec < 3600 ? yellow("idle") : red("stopped");
    const sizeKB = (stat.size / 1024).toFixed(1) + " KB";
    const mtime = new Date(stat.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `${n.padEnd(20)}  ${status.padEnd(10)}  ${p.padEnd(50)}  ${sizeKB.padEnd(9)}  ${mtime}`
    );
  }
}

/** commander 注册：`svcctl log [name] [-f] [-n N]` */
export function register(program: Command): void {
  program
    .command("log [name]")
    .description(
      "Show or follow log for an entry (omit name to list all logs; fuzzy name match)"
    )
    .option("-f, --follow", "follow new output (tail -f style)")
    .option("-n, --lines <n>", "show last N lines (-n 0 with -f to skip history)", (v: string) =>
      parseInt(v, 10)
    )
    .action(async (name: string | undefined, opts: LogOptions) => {
      await logCommand(name, opts);
    });
}
