/**
 * macOS: 写 ~/Library/LaunchAgents/com.svcctl.supervisor.plist + launchctl bootstrap
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { supervisorLogPath, installedFlagPath } from "../paths";
import { info } from "../format";

const PLIST_LABEL = "com.svcctl.supervisor";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
}

export interface MacOSInstallOptions {
  /** CLI shim 绝对路径（bin/svcctl.js） */
  cliPath: string;
  /** home dir override */
  homeDir?: string;
}

/** install: 写 plist + launchctl bootstrap + 写 installed.flag */
export function installMacOS(opts: MacOSInstallOptions): void {
  if (process.platform !== "darwin") {
    throw new Error("installMacOS should only be called on macOS");
  }

  const agentsDir = join(opts.homeDir ?? homedir(), "Library", "LaunchAgents");
  mkdirSync(agentsDir, { recursive: true });
  const plist = generatePlist(opts.cliPath, opts.homeDir);
  const plistFile = plistPath();
  writeFileSync(plistFile, plist, "utf-8");
  info(`wrote plist to ${plistFile}`);

  // 用 modern bootstrap 语法
  const uid = process.getuid?.() ?? execSync("id -u").toString().trim();
  try {
    execSync(`launchctl bootstrap gui/${uid} "${plistFile}"`, { stdio: "pipe" });
    info(`bootstrapped ${PLIST_LABEL}`);
  } catch {
    // 可能已存在，先 bootout 再 bootstrap
    try {
      execSync(`launchctl bootout gui/${uid}/${PLIST_LABEL}`, { stdio: "pipe" });
    } catch {}
    execSync(`launchctl bootstrap gui/${uid} "${plistFile}"`, { stdio: "pipe" });
    info(`bootstrapped ${PLIST_LABEL}`);
  }

  writeFileSync(installedFlagPath(), plistFile, "utf-8");
}

/** uninstall: launchctl bootout + 删 plist */
export function uninstallMacOS(): void {
  if (process.platform !== "darwin") return;
  const uid = process.getuid?.() ?? execSync("id -u").toString().trim();
  try {
    execSync(`launchctl bootout gui/${uid}/${PLIST_LABEL}`, { stdio: "pipe" });
  } catch {
    /* not loaded */
  }
  const file = plistPath();
  if (existsSync(file)) unlinkSync(file);
  if (existsSync(installedFlagPath())) {
    try {
      unlinkSync(installedFlagPath());
    } catch {}
  }
}

/** isInstalled */
export function isInstalledMacOS(): boolean {
  return process.platform === "darwin" && existsSync(plistPath());
}

function generatePlist(cliPath: string, homeDir?: string): string {
  const log = supervisorLogPath(); // 默认用 ~/.svcctl/supervisor.log
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>bun</string>
    <string>run</string>
    <string>${cliPath}</string>
    <string>_supervise</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SVCCTL_HOME</key><string>${homeDir ?? homedir()}/.svcctl</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}
