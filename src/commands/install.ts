/**
 * svcctl install / uninstall
 */
import { install as doInstall, uninstall as doUninstall, isInstalled } from "../install";
import { success, error, info } from "../format";

export function installCommand(): void {
  if (isInstalled()) {
    info("svcctl is already installed.");
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

export function uninstallCommand(): void {
  if (!isInstalled()) {
    info("svcctl is not installed.");
    return;
  }
  try {
    doUninstall();
    success("uninstalled.");
  } catch (e) {
    error((e as Error).message);
    process.exit(1);
  }
}
