/**
 * v0.4.11: 读 Windows PE FileVersion 字段作为 supervisor version source of truth。
 * 之前用 `~/.svcctl/supervisor.version` 文件记录版本，跟实际 PE 二进制可能错位
 * （build.rs 没 rerun Cargo.toml 改了嵌不到新 version 到 PE）。改成读 PE 资源是单一来源。
 *
 * 内部用 PowerShell 调 [System.Diagnostics.FileVersionInfo] —— 50ms 一次，
 * 跨平台 spawn powershell 不会失败（非 Windows 平台直接 return ""）。
 */
import { execSync } from "node:child_process";

/**
 * 读 PE FileVersion 字段（任务管理器「详细信息」/ 资源管理器属性页显示的版本）。
 * 返回 4 段格式 "0.4.11.0"（带末尾 .0）。文件不存在 / 读失败 / 非 Windows → ""。
 * 对比时 caller 要 normalize（strip 末尾 .0）。
 */
export function readExeVersion(exePath: string): string {
  if (process.platform !== "win32") return "";
  try {
    const escapedPath = exePath.replace(/'/g, "''");
    const out = execSync(
      `powershell -NoProfile -Command "[System.Diagnostics.FileVersionInfo]::GetVersionInfo('${escapedPath}').FileVersion"`,
      { stdio: "pipe", encoding: "utf-8" },
    ).trim();
    return out;
  } catch {
    return "";
  }
}

/** 规范化四段 PE version；三段 semver 的 patch=0 必须保留。 */
export function normalizeVersion(v: string): string {
  return v.replace(/^(\d+\.\d+\.\d+)\.0$/, "$1");
}
