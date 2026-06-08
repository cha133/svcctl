/**
 * svcctl log [<name>] [-f] [-n <lines>]
 */
import { listEntries } from "../entries/store";
import { logPath, logsDir } from "../paths";
import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { error, info } from "../format";
import { green, red, yellow, dim } from "../format";

export interface LogOptions {
  follow?: boolean;
  lines?: number;
}

export async function logCommand(name: string | undefined, opts: LogOptions): Promise<void> {
  // 1. 无 name + 无 -f → 列表模式
  if (!name) {
    if (opts.follow) {
      error("`svcctl log -f` requires an entry name. Usage: svcctl log <name> -f");
      process.exit(1);
    }
    listLogs();
    return;
  }

  const file = logPath(name);
  if (!existsSync(file)) {
    error(`log file not found: ${file}`);
    error('Has entry "' + name + '" ever been spawned? Check `svcctl ls`.');
    process.exit(1);
  }

  // 2. 有 name + 无 -f → 打印
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

  // 3. 有 name + -f → 跟随模式
  let offset = statSync(file).size;
  // 先打已有内容（可选：避免 -f 启动时错过已写入的内容）
  // 简单实现：-f 只追新内容；如果想看历史先不加 -f
  process.stdout.write(dim(`[following ${file}]` + "\n"));
  process.stdout.write(dim("[press Ctrl-C to stop]\n"));

  const interval = setInterval(() => {
    try {
      const stat = statSync(file);
      if (stat.size > offset) {
        const fd = readFileSync(file, { encoding: "utf-8", flag: "r" });
        process.stdout.write(fd.slice(offset));
        offset = stat.size;
      } else if (stat.size < offset) {
        // 日志被 truncate 了，重置 offset
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
  const names = new Set<string>([...entryNames, ...files.map((f) => f.replace(/\.log$/, ""))]);

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
    const status = ageSec < 60 ? green("running") : ageSec < 3600 ? yellow("idle") : red("stopped");
    const sizeKB = (stat.size / 1024).toFixed(1) + " KB";
    const mtime = new Date(stat.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
    console.log(
      `${n.padEnd(20)}  ${status.padEnd(10)}  ${p.padEnd(50)}  ${sizeKB.padEnd(9)}  ${mtime}`
    );
  }
}
