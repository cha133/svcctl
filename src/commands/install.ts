/**
 * svcctl install / uninstall
 */
import { install as doInstall, uninstall as doUninstall, isInstalled } from "../install";
import { success, error, info } from "../format";
import { stopCommand } from "./stop";
import { ensureSupervisorUpToDate } from "./helpers";
import type { Command } from "commander";

export function installCommand(): void {
  if (isInstalled()) {
    // 已安装：仍然确保 supervisor 二进制是最新版
    const status = ensureSupervisorUpToDate();
    if (status === "upgraded") {
      success("supervisor binary updated.");
    } else if (status === "needs-restart") {
      info("supervisor is running an older version. Restart to upgrade: svcctl stop && svcctl start");
    } else {
      info("svcctl is already installed and up-to-date.");
    }
    return;
  }
  try {
    doInstall();
    success("installed.");
  } catch (e) {
    error((e as Error).message);
    process.exit(1);
  }
}

export async function uninstallCommand(): Promise<void> {
  if (!isInstalled()) {
    info("svcctl is not installed.");
    return;
  }
  try {
    // 先停 supervisor，否则 Windows 下 .exe 还被持有，后续 unlink / 二次 install 的 copyFileSync 会被 EBUSY 卡住
    await stopCommand();
    doUninstall();
    success("uninstalled.");
  } catch (e) {
    error((e as Error).message);
    process.exit(1);
  }
}

/** commander 注册：`svcctl install` 和 `svcctl uninstall` */
export function register(program: Command): void {
  program
    .command("install")
    .description("Install the supervisor to auto-start on user login")
    .action(() => {
      installCommand();
    });
  program
    .command("uninstall")
    .description("Uninstall the supervisor")
    .action(async () => {
      await uninstallCommand();
    });
}
