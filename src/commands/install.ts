/**
 * svcctl install / uninstall
 */
import { install as doInstall, uninstall as doUninstall, isInstalled } from "../install";
import { success, error, info } from "../format";
import { stopCommand } from "./stop";
import { checkSupervisorVersion, warnSupervisorOutdated } from "./helpers";
import type { Command } from "commander";

export async function installCommand(): Promise<void> {
  if (isInstalled()) {
    // v0.4.11: 已安装 → 只 check version，outdated 时 warn 让用户跑 `svcctl upgrade`
    // （不再自动升级；升级统一收口到 `svcctl upgrade` 命令）
    const status = await checkSupervisorVersion();
    if (status === "outdated") {
      warnSupervisorOutdated();
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
    .action(async () => {
      await installCommand();
    });
  program
    .command("uninstall")
    .description("Uninstall the supervisor")
    .action(async () => {
      await uninstallCommand();
    });
}
