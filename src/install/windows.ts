/**
 * Windows: HKCU\Run + copy supervisor.exe 到 ~/.svcctl/bin/
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { ensureSvcctlDir, windowsSupervisorPath, installedFlagPath, ensureDir } from "../paths";
import { info } from "../format";

const REG_KEY = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
const REG_NAME = "SvcCtl";

/** install: copy supervisor + 写注册表 + 写 installed.flag */
export function installWindows(bundledSupervisorPath: string): void {
  if (process.platform !== "win32") {
    throw new Error("installWindows should only be called on Windows");
  }

  ensureSvcctlDir();
  const dest = windowsSupervisorPath();
  ensureDir(dirname(dest));

  // 拷贝 .exe
  if (!existsSync(bundledSupervisorPath)) {
    throw new Error(
      `Bundled supervisor not found: ${bundledSupervisorPath}\n` +
        `Build it first with: pwsh scripts/build-launcher.ps1`
    );
  }
  copyFileSync(bundledSupervisorPath, dest);
  info(`copied supervisor to ${dest}`);

  // 写注册表
  const cmd = `reg add "${REG_KEY}" /v ${REG_NAME} /t REG_SZ /d "\\"${dest}\\"" /f`;
  try {
    execSync(cmd, { stdio: "pipe" });
    info(`registered ${REG_NAME} in ${REG_KEY}`);
  } catch (e) {
    throw new Error(`Failed to register Run key: ${(e as Error).message}`);
  }

  // 写 installed.flag
  writeFileSync(installedFlagPath(), dest, "utf-8");
}

/** uninstall: 删注册表 + 删 .exe */
export function uninstallWindows(): void {
  if (process.platform !== "win32") return;

  try {
    execSync(`reg delete "${REG_KEY}" /v ${REG_NAME} /f`, { stdio: "pipe" });
    info(`removed ${REG_NAME} from ${REG_KEY}`);
  } catch {
    // 没注册过，跳过
  }

  const dest = windowsSupervisorPath();
  if (existsSync(dest)) {
    try {
      unlinkSync(dest);
      info(`removed supervisor ${dest}`);
    } catch {
      // 删不掉（文件被占用等）不阻塞
    }
  }

  // 删 installed.flag
  if (existsSync(installedFlagPath())) {
    try {
      unlinkSync(installedFlagPath());
    } catch {}
  }
}

/** isInstalled */
export function isInstalledWindows(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const out = execSync(`reg query "${REG_KEY}" /v ${REG_NAME}`, { stdio: "pipe" }).toString();
    return out.includes(REG_NAME);
  } catch {
    return false;
  }
}
