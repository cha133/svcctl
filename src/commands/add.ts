/**
 * svcctl add <command...> [--name N] [--cwd D] [--env K=V]... [--no-install]
 */
import { addEntry } from "../entries/store";
import { slugify, validateSlug } from "../entries/name";
import { looksLikeShellTokenizationMistake } from "../entries/command";
import type { Entry } from "../entries/types";
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { installedFlagPath } from "../paths";
import { install as doInstall } from "../install";
import { success, error, info } from "../format";

export interface AddOptions {
  name?: string;
  cwd?: string;
  env?: string[]; // ["KEY=VAL", ...]
  noInstall?: boolean;
  /** v0.4.7: 子进程死了 opt-in 自动重启 */
  restart?: boolean;
}

export async function addCommand(commandArgs: string[], opts: AddOptions): Promise<void> {
  if (commandArgs.length === 0) {
    error("Usage: svcctl add <command> [args...] [--name N] [--cwd D] [--env K=V]...");
    process.exit(1);
  }

  const command = commandArgs[0]!;
  const args = commandArgs.slice(1);

  // 0. 拒明显是引号 tokenization 错误的 command（如 "cctra serve"）
  //    commander 把每个 shell token 视作独立参数，引号是字面文本
  if (looksLikeShellTokenizationMistake(command)) {
    error(
      `command "${command}" contains a space but no path separator — this is usually a shell tokenization mistake.`
    );
    error(
      `commander treats each token as a separate argument; the quotes were literal text.`
    );
    error(`try (no quotes around the whole thing):`);
    error(`  svcctl add ${command}`);
    process.exit(1);
  }

  // 1. 派生 name
  let name = opts.name ?? slugify(command, ...args);
  if (!name) {
    error(
      `Cannot derive a name from "${[command, ...args].join(" ")}" (resulted in empty slug).`
    );
    error(`Use --name <name> to specify explicitly.`);
    process.exit(1);
  }
  if (!validateSlug(name)) {
    error(`Invalid slug: "${name}". Must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
    error(`Use --name <name> to specify a valid slug explicitly.`);
    process.exit(1);
  }

  // 2. 校验 cwd
  if (opts.cwd && !existsSync(opts.cwd)) {
    error(`cwd does not exist: ${opts.cwd}`);
    process.exit(1);
  }

  // 3. 解析 env
  const env: Record<string, string> = {};
  for (const kv of opts.env ?? []) {
    const eq = kv.indexOf("=");
    if (eq <= 0) {
      error(`Invalid --env "${kv}" (expected KEY=VAL).`);
      process.exit(1);
    }
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    env[k] = v;
  }

  // 4. add
  const entry: Entry = {
    name,
    command,
    args,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(opts.restart ? { restart: true } : {}),
    createdAt: new Date().toISOString(),
  };

  try {
    addEntry(entry);
  } catch (e) {
    error((e as Error).message);
    process.exit(1);
  }
  success(
    `added entry "${name}" → ${command} ${args.join(" ")}${opts.restart ? " (auto-restart on crash)" : ""}`
  );

  // 5. 首次 add → 自动 install
  if (!opts.noInstall && !existsSync(installedFlagPath())) {
    info(`first add detected, installing OS supervisor...`);
    try {
      doInstall();
    } catch (e) {
      error(`auto-install failed: ${(e as Error).message}`);
      info(`entry is saved; run \`svcctl install\` manually to register the supervisor.`);
      return;
    }
  }

  // 6. 如果 supervisor 在跑，热重载会自动接管（fs.watch / mtime 合并到 reap）
  info(`entry persisted to ~/.svcctl/entries.toml. Supervisor will pick it up automatically.`);
}

/** commander 注册：`svcctl add <cmd...> [--name N] [--cwd D] [--env K=V]... [--no-install]` */
export function register(program: Command): void {
  program
    .command("add <cmd...>")
    .description("Add a command to be supervised on user login")
    .option("-n, --name <name>", "explicit entry name (default: derived from command)")
    .option("--cwd <cwd>", "working directory")
    .option("-e, --env <kv...>", "env var KEY=VAL (can repeat)")
    .option("--restart", "opt-in auto-restart on child exit (v0.4.7)")
    .option("--no-install", "skip auto-install on first add")
    .action(
      async (
        cmd: string[],
        opts: { name?: string; cwd?: string; env?: string[]; install?: boolean; restart?: boolean }
      ) => {
        await addCommand(cmd, {
          name: opts.name,
          cwd: opts.cwd,
          env: opts.env,
          noInstall: opts.install === false,
          restart: opts.restart === true,
        });
      }
    );
}
