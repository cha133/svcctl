/**
 * svcctl CLI 入口 —— 手写 argv 解析
 */
import { addCommand, type AddOptions } from "./commands/add";
import { removeCommand } from "./commands/remove";
import { lsCommand } from "./commands/ls";
import { logCommand, type LogOptions } from "./commands/log";
import { startCommand } from "./commands/start";
import { stopCommand } from "./commands/stop";
import { statusCommand } from "./commands/status";
import { installCommand, uninstallCommand } from "./commands/install";
import { runSupervisor } from "./supervise";
import { error, info, dim } from "./format";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? "";
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        // 如果下一个不是 flag 或 =，认为是值
        if (next && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

function parseEnvFlags(flags: Record<string, string | boolean>): string[] {
  const env: string[] = [];
  for (const [k, v] of Object.entries(flags)) {
    if (k === "env" && typeof v === "string") {
      env.push(v);
    } else if (k === "env") {
      // --env 后面接了多个值（罕见）：跳过
    }
  }
  return env;
}

function help(): void {
  console.log(`svcctl — cross-platform startup supervisor

Usage:
  svcctl add <command> [args...] [--name N] [--cwd D] [--env K=V]... [--no-install]
  svcctl remove <name> | --all
  svcctl ls
  svcctl log [<name>] [-f] [-n <lines>]
  svcctl start
  svcctl stop
  svcctl status
  svcctl install
  svcctl uninstall
  svcctl _supervise         (hidden — supervisor entry point)
  svcctl help

Examples:
  svcctl add bunx cctra
  svcctl add bun run foo.js --name foo
  svcctl log foo -f
  svcctl remove foo

Docs: ${dim("see README.md")}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { command, positional, flags } = args;

  switch (command) {
    case "":
    case "help":
    case "-h":
    case "--help":
      help();
      return;

    case "add": {
      const opts: AddOptions = {
        name: typeof flags.name === "string" ? flags.name : undefined,
        cwd: typeof flags.cwd === "string" ? flags.cwd : undefined,
        env: parseEnvFlags(flags),
        noInstall: flags["no-install"] === true,
      };
      await addCommand(positional, opts);
      return;
    }

    case "remove":
    case "rm": {
      await removeCommand(positional[0], { all: flags.all === true });
      return;
    }

    case "ls":
    case "list":
      lsCommand();
      return;

    case "log": {
      const opts: LogOptions = {
        follow: flags.f === true || flags.follow === true,
        lines: typeof flags.n === "string" ? parseInt(flags.n, 10) : undefined,
      };
      await logCommand(positional[0], opts);
      return;
    }

    case "start":
      await startCommand();
      return;

    case "stop":
      await stopCommand();
      return;

    case "status":
      statusCommand();
      return;

    case "install":
      installCommand();
      return;

    case "uninstall":
      uninstallCommand();
      return;

    case "_supervise":
      // 隐藏子命令：被 launchd / systemd / HKCU\Run 触发
      await runSupervisor();
      return;

    default:
      error(`unknown command: ${command}`);
      info("run `svcctl help` for usage");
      process.exit(1);
  }
}

main().catch((e) => {
  error((e as Error).message);
  process.exit(1);
});
