/**
 * v0.4.13: `svcctl upgrade` 显式升级 supervisor 二进制。
 *
 * 流程（删 NTFS rename trick）：
 *   1. check PE version
 *   2. supervisor 跑着 → 问用户是否 restart（默认 Yes；pipe 默认 Yes 不阻塞）
 *      - 用户同意 → stopCommand → 等 supervisor exit → copyFileSync bundled → dest → startCommand
 *      - 用户拒绝 → 提示手动 `svcctl stop && svcctl upgrade`
 *   3. supervisor 没跑着 → 直接 copyFileSync → 提示 `svcctl start`
 *
 * 不再需要 .old 文件、NTFS rename、Job Object upgrade 路径——supervisor stop 后 dest
 * 一定没锁，copyFileSync 一定能成功。
 */
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import type { Command } from "commander";
import { isSupervisorRunning, checkSupervisorVersion } from "./helpers";
import { defaultWindowsSupervisorPath } from "../install";
import { upgradeWindowsSupervisor, currentVersion } from "../install/windows";
import { stopCommand } from "./stop";
import { startCommand } from "./start";
import { success, info, error, warn } from "../format";
import { windowsSupervisorPath } from "../paths";
import { readExeVersion, normalizeVersion } from "../install/exe-version";

export async function upgradeCommand(): Promise<void> {
  const status = await checkSupervisorVersion();
  if (status === "up-to-date") {
    success(`supervisor is up-to-date (v${currentVersion()})`);
    return;
  }

  const current = currentVersion();
  const installed = normalizeVersion(readExeVersion(windowsSupervisorPath())) || "?";

  // v0.4.14: verify bundled PE 跟 currentVersion 一致——否则 dev 用户没重 build 就跑 upgrade，
  // 会把错位的 binary 当新版装上去（误导性 success "upgraded to vX.Y.Z"，实际装的是旧版）
  const bundledPath = defaultWindowsSupervisorPath();
  const bundledVer = normalizeVersion(readExeVersion(bundledPath));
  if (!bundledVer || bundledVer !== current) {
    error(
      `bundled supervisor (${bundledPath}) is v${bundledVer || "?"}, ` +
      `but CLI version is v${current}. Run \`bun run build:launcher\` first to rebuild.`,
    );
    process.exit(1);
  }

  info(`upgrading supervisor from v${installed} to v${current}`);

  // Windows + supervisor 跑着 → 问 restart → yes → stop → copy → 自动 start
  let shouldStartAfter = false;
  if (process.platform === "win32" && isSupervisorRunning()) {
    const choice = await promptYesNo(`Restart supervisor to apply upgrade? [Y/n]`, true);
    if (!choice) {
      info(`Upgrade deferred. Run \`svcctl stop && svcctl upgrade\` later to apply.`);
      return;
    }
    await stopCommand();
    shouldStartAfter = true; // 用户同意 restart → 升级后自动 start
  }

  // supervisor 没跑着 或刚 stop → 直接 copy（不会失败）
  const result = await upgradeWindowsSupervisor(bundledPath);
  if (result === "up-to-date") {
    warn(`Upgrade failed. Try again after stopping supervisor.`);
    return;
  }

  // 升级成功
  if (shouldStartAfter) {
    await startCommand();
    success(`upgraded to v${current}`);
  } else {
    info(`Run \`svcctl start\` to launch the new binary.`);
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
