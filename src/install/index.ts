/**
 * 平台分发：install / uninstall / isInstalled
 */
import { installWindows, isInstalledWindows, uninstallWindows } from "./windows";
import { installMacOS, isInstalledMacOS, uninstallMacOS } from "./macos";
import { installLinux, isInstalledLinux, uninstallLinux } from "./linux";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** install 的可选项 */
export interface InstallOptions {
  /** 显式传入 supervisor 路径（Windows 用），否则按平台默认推断 */
  bundledSupervisorPath?: string;
  /** 显式传入 CLI shim 路径（macOS / Linux 用），否则用 import.meta.url 推断 */
  svcctlCliPath?: string;
  /** 显式传入 home dir，默认 os.homedir() */
  homeDir?: string;
}

/** 从 import.meta.url 推断出 bin/svcctl.js 的绝对路径 */
function defaultSvcctlCliPath(): string {
  // import.meta.url 形如 "file:///C:/Dev/svcctl/bin/svcctl.js" 或 "file:///.../src/index.ts"
  const url = import.meta.url;
  const path = fileURLToPath(url);
  // 如果是 src/ 下的开发路径，向上找 bin/svcctl.js
  if (path.includes(`${join("src", "index.ts")}`) || path.includes(`${join("src", "index.js")}`)) {
    return join(dirname(path), "..", "bin", "svcctl.js");
  }
  // 如果是 bin/svcctl.js 自身（生产 shim），直接用
  return path;
}

export function install(opts: InstallOptions = {}): void {
  const platform = process.platform;
  if (platform === "win32") {
    const sup = opts.bundledSupervisorPath ?? defaultWindowsSupervisorPath();
    if (!existsSync(sup)) {
      throw new Error(
        `Windows supervisor not found: ${sup}\n` +
          `Build it first with: pwsh scripts/build-launcher.ps1`
      );
    }
    installWindows(sup);
  } else if (platform === "darwin") {
    installMacOS({ cliPath: opts.svcctlCliPath ?? defaultSvcctlCliPath(), homeDir: opts.homeDir });
  } else if (platform === "linux") {
    installLinux({ cliPath: opts.svcctlCliPath ?? defaultSvcctlCliPath(), homeDir: opts.homeDir });
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

export function uninstall(): void {
  const platform = process.platform;
  if (platform === "win32") {
    uninstallWindows();
  } else if (platform === "darwin") {
    uninstallMacOS();
  } else if (platform === "linux") {
    uninstallLinux();
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}

export function isInstalled(): boolean {
  const platform = process.platform;
  if (platform === "win32") return isInstalledWindows();
  if (platform === "darwin") return isInstalledMacOS();
  if (platform === "linux") return isInstalledLinux();
  return false;
}

/** 推断 Windows supervisor 路径：向上递归找 bin/SvcCtl.exe */
export function defaultWindowsSupervisorPath(): string {
  // 从当前模块 url 向上递归找 bin/SvcCtl.exe —— 三个调用场景都支持:
  //   1. bun link (项目目录):           <project>/src/install/index.ts  → <project>/bin/SvcCtl.exe
  //   2. bunx svcctl install (临时):     <npm-cache>/svcctl/.../install/index.ts  → <npm-cache>/svcctl/.../bin/SvcCtl.exe
  //   3. bun add -g svcctl install:     <global>/node_modules/svcctl/.../install/index.ts  → <global>/node_modules/svcctl/.../bin/SvcCtl.exe
  // 前提: package.json "files" 包含 bin/ (让 npm pack 带上 SvcCtl.exe)
  const path = fileURLToPath(import.meta.url);
  let dir = dirname(path);
  // 防御: 最多向上 20 层, 避免符号链接循环
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, "bin", "SvcCtl.exe");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;  // 到根目录了
    dir = parent;
  }
  throw new Error(
    "supervisor not found: bin/SvcCtl.exe (向上递归 20 层都没找到). " +
    "Pass bundledSupervisorPath to install() explicitly, " +
    "or build with: pwsh scripts/build-launcher.ps1"
  );
}
