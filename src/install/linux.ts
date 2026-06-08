/**
 * Linux: 写 ~/.config/systemd/user/svcctl.service + systemctl --user enable --now
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { supervisorLogPath, installedFlagPath } from "../paths";
import { info } from "../format";

const UNIT_NAME = "svcctl.service";

export function unitPath(): string {
  return join(homedir(), ".config", "systemd", "user", UNIT_NAME);
}

export interface LinuxInstallOptions {
  cliPath: string;
  homeDir?: string;
}

/** install: 写 unit + systemctl enable --now + 写 installed.flag */
export function installLinux(opts: LinuxInstallOptions): void {
  if (process.platform !== "linux") {
    throw new Error("installLinux should only be called on Linux");
  }

  const userDir = join(opts.homeDir ?? homedir(), ".config", "systemd", "user");
  mkdirSync(userDir, { recursive: true });
  const unit = generateUnit(opts.cliPath, opts.homeDir);
  const unitFile = unitPath();
  writeFileSync(unitFile, unit, "utf-8");
  info(`wrote unit to ${unitFile}`);

  try {
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
    execSync("systemctl --user enable --now svcctl.service", { stdio: "pipe" });
    info(`enabled and started ${UNIT_NAME}`);
  } catch (e) {
    throw new Error(`systemctl failed: ${(e as Error).message}`);
  }

  writeFileSync(installedFlagPath(), unitFile, "utf-8");
}

/** uninstall */
export function uninstallLinux(): void {
  if (process.platform !== "linux") return;
  try {
    execSync("systemctl --user disable --now svcctl.service", { stdio: "pipe" });
  } catch {
    /* not enabled */
  }
  const file = unitPath();
  if (existsSync(file)) unlinkSync(file);
  try {
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
  } catch {}
  if (existsSync(installedFlagPath())) {
    try {
      unlinkSync(installedFlagPath());
    } catch {}
  }
}

/** isInstalled */
export function isInstalledLinux(): boolean {
  return process.platform === "linux" && existsSync(unitPath());
}

function generateUnit(cliPath: string, homeDir?: string): string {
  const home = homeDir ?? homedir();
  const log = supervisorLogPath();
  return `[Unit]
Description=svcctl supervisor
After=network.target

[Service]
Type=simple
Environment=SVCCTL_HOME=${home}/.svcctl
ExecStart=/usr/bin/env bun run ${cliPath} _supervise
Restart=always
RestartSec=3
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}
