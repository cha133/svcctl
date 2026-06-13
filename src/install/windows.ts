/**
 * Windows: HKCU\Run + copy supervisor.exe 到 ~/.svcctl/bin/
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, renameSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSvcctlDir, windowsSupervisorPath, installedFlagPath, ensureDir, supervisorVersionPath, supervisorPidPath } from "../paths";
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

  // 写版本文件
  writeFileSync(supervisorVersionPath(), currentVersion(), "utf-8");
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

/** 当前 CLI 版本号（来自 package.json） */
export function currentVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // import.meta.url → .../src/install/windows.ts
    // dirname → .../src/install/  →  再向上 2 层到项目根
    const pkgPath = join(dirname(here), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * 升级 Windows supervisor 二进制（如果版本不匹配）。
 *
 * 返回：
 *   "up-to-date"     — 版本一致，无需操作
 *   "upgraded"       — 已复制新二进制 + 更新版本文件
 *   "needs-restart"  — supervisor 运行中，已用 NTFS rename 技巧准备好新二进制，需重启才生效
 */
export function upgradeWindowsSupervisor(bundledPath: string): "up-to-date" | "upgraded" | "needs-restart" {
  if (process.platform !== "win32") return "up-to-date";
  if (!existsSync(bundledPath)) return "up-to-date"; // bundled 不存在就不升级

  const dest = windowsSupervisorPath();
  const versionPath = supervisorVersionPath();
  const ver = currentVersion();

  // 读取已安装版本
  let installedVer = "";
  if (existsSync(versionPath)) {
    try { installedVer = readFileSync(versionPath, "utf-8").trim(); } catch {}
  }

  // 版本一致 → 无需操作
  if (installedVer === ver && existsSync(dest)) return "up-to-date";

  // 确保目标目录存在
  ensureDir(dirname(dest));

  // 检查 supervisor 是否在运行
  let supervisorRunning = false;
  const pidPath = supervisorPidPath();
  if (existsSync(pidPath)) {
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (pid > 0) {
        process.kill(pid, 0);
        supervisorRunning = true;
      }
    } catch {}
  }

  if (!supervisorRunning) {
    // supervisor 没运行，直接覆盖
    copyFileSync(bundledPath, dest);
    writeFileSync(versionPath, ver, "utf-8");
    info(`supervisor binary updated to v${ver}`);
    return "upgraded";
  }

  // supervisor 运行中：NTFS rename 技巧
  // 运行中的 exe 不能覆盖，但可以重命名，然后 copy 新的到原位
  try {
    const oldPath = dest + ".old";
    // 清理上次可能遗留的 .old
    try { unlinkSync(oldPath); } catch {}
    renameSync(dest, oldPath);
    copyFileSync(bundledPath, dest);
    writeFileSync(versionPath, ver, "utf-8");
    info(`supervisor binary prepared for upgrade to v${ver} (restart to apply)`);
    return "needs-restart";
  } catch {
    // rename 或 copy 失败（极端情况），无法升级
    return "needs-restart";
  }
}
