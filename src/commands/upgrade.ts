/**
 * v0.4.11: `svcctl upgrade` 显式升级 supervisor 二进制。
 *
 * 之前 start / install / stop 都自动调 ensureSupervisorUpToDate() 隐式升级，
 * 跟其他命令耦合 + 容易出错（dest 锁着 / supervisor.version 写失败等）。
 * 现在升级统一收口到这一个命令，跑完交互式问用户是否自动 restart supervisor（默认 Yes）。
 */
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import type { Command } from "commander";
import { isSupervisorRunning, checkSupervisorVersion } from "./helpers";
import { defaultWindowsSupervisorPath } from "../install";
import { upgradeWindowsSupervisor, currentVersion } from "../install/windows";
import { stopCommand } from "./stop";
import { startCommand } from "./start";
import { success, info, error } from "../format";
import { windowsSupervisorPath } from "../paths";
import { readExeVersion, normalizeVersion } from "../install/exe-version";

export async function upgradeCommand(): Promise<void> {
  const status = await checkSupervisorVersion();
  if (status === "up-to-date") {
    success(`supervisor is up-to-date (v${currentVersion()})`);
    return;
  }

  // outdated：显示当前 / 新版本（readExeVersion 返回 "0.4.11.0" 4 段，normalize 后 "0.4.11"）
  const installed = normalizeVersion(readExeVersion(windowsSupervisorPath())) || "?";
  const current = currentVersion();
  info(`upgrading supervisor from v${installed} to v${current}`);

  const result = await upgradeWindowsSupervisor(defaultWindowsSupervisorPath());
  if (result === "up-to-date" || result === "upgraded") {
    success(`upgraded to v${current}`);
    return;
  }
  // needs-restart：supervisor 跑着，新二进制已就位
  // （upgradeWindowsSupervisor 内部已打了 info 提示，这里不再重复 warn）

  if (isSupervisorRunning()) {
    const choice = await promptYesNo("Restart supervisor now? [Y/n]", true);
    if (choice) {
      await stopCommand();
      await startCommand();
      success("supervisor restarted with new binary.");
    } else {
      info("Run `svcctl stop && svcctl start` later to apply upgrade.");
    }
  } else {
    info("Run `svcctl start` to launch the new binary.");
  }
}

/**
 * 交互式 yes/no 提示。
 * - TTY：显示 prompt，读一行，Enter 接受 defaultYes
 * - pipe/CI：直接返回 defaultYes（不阻塞）
 */
function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (!stdin.isTTY) return Promise.resolve(defaultYes);
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "y" || trimmed === "yes") return resolve(true);
      if (trimmed === "n" || trimmed === "no") return resolve(false);
      return resolve(defaultYes); // Enter 接受默认
    });
  });
}

/** commander 注册：`svcctl upgrade` */
export function register(program: Command): void {
  program
    .command("upgrade")
    .description("Upgrade the supervisor binary to the bundled version")
    .action(async () => {
      try {
        await upgradeCommand();
      } catch (e) {
        error((e as Error).message);
        process.exit(1);
      }
    });
}
