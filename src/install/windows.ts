/**
 * Windows: HKCU\Run + copy supervisor.exe 到 ~/.svcctl/bin/
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSvcctlDir, windowsSupervisorPath, installedFlagPath, ensureDir, ensureStateDir } from "../paths";
import { info, warn } from "../format";
import { readExeVersion, normalizeVersion } from "./exe-version";

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
  setWindowsRunKey(dest);

  // 写 installed.flag
  ensureStateDir();
  writeFileSync(installedFlagPath(), dest, "utf-8");

  // v0.4.11: 删 supervisor.version 文件 —— PE FileVersion 是 ground truth
}

/** uninstall: 删注册表 + 删 .exe */
export function uninstallWindows(): void {
  if (process.platform !== "win32") return;

  removeWindowsRunKey();

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

/** 写 HKCU\Run（测试可 mock） */
export function setWindowsRunKey(dest: string): void {
  const cmd = `reg add "${REG_KEY}" /v ${REG_NAME} /t REG_SZ /d "\\"${dest}\\"" /f`;
  try {
    execSync(cmd, { stdio: "pipe" });
    info(`registered ${REG_NAME} in ${REG_KEY}`);
  } catch (e) {
    throw new Error(`Failed to register Run key: ${(e as Error).message}`);
  }
}

/** 删 HKCU\Run（没注册过不抛） */
export function removeWindowsRunKey(): void {
  try {
    execSync(`reg delete "${REG_KEY}" /v ${REG_NAME} /f`, { stdio: "pipe" });
    info(`removed ${REG_NAME} from ${REG_KEY}`);
  } catch {
    // 没注册过，跳过
  }
}

/** isInstalled */
export function isInstalledWindows(): boolean {
  if (process.platform !== "win32") {
    throw new Error("isInstalledWindows should only be called on Windows");
  }
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
 * v0.4.13: 升级 Windows supervisor 二进制（如果版本不匹配）。
 *
 * 返回：
 *   "up-to-date"  — 版本一致，无需操作
 *   "upgraded"    — 已复制新二进制（dest 不被锁时；caller 保证 dest 解锁）
 *
 * v0.4.13 改动：删 NTFS rename trick（修了好几个版本，浪费 100M token）。
 * 现在 caller 必须保证 dest 没锁——supervisor 没跑，或 caller 先 stop supervisor。
 * `svcctl upgrade` 走 stop → copy → start 干净路径。
 */
export async function upgradeWindowsSupervisor(
  bundledPath: string,
): Promise<"up-to-date" | "upgraded"> {
  if (process.platform !== "win32") return "up-to-date";
  if (!existsSync(bundledPath)) return "up-to-date"; // bundled 不存在就不升级

  const dest = windowsSupervisorPath();
  const ver = currentVersion();

  // v0.4.11: 读 PE FileVersion 判定（build.rs winres 嵌的，跟 Cargo.toml 同步）
  const installedVer = readExeVersion(dest);
  if (installedVer && normalizeVersion(installedVer) === ver && existsSync(dest)) {
    return "up-to-date";
  }

  // 确保目标目录存在
  ensureDir(dirname(dest));

  // 直接 copyFileSync（caller 保证 dest 没锁——supervisor 没跑，或刚 stop）
  try {
    copyFileSync(bundledPath, dest);
    info(`supervisor binary updated to v${ver}`);
    return "upgraded";
  } catch (e) {
    warn(`supervisor binary update failed: ${(e as Error).message}`);
    // copy fail（dest 仍被锁——caller 没保证好） → 当 up-to-date 处理，caller 决定下一步
    return "up-to-date";
  }
}
