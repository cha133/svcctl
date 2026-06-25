/**
 * v0.5.5: installMacOS 在全新机器上写 plist + flag，不抛
 *
 * 关键约束：
 * 1. 仅 macOS（process.platform === "darwin"）
 * 2. HOME 指向空 temp dir（全新 install 模拟）
 * 3. mock 掉 execSync——不真调 launchctl
 *
 * 验证 v0.5.5 简化：
 * - 生成的 plist 不含 `<key>SVCCTL_HOME</key>`
 * - 生成的 plist 不含 `<key>EnvironmentVariables</key>`
 * - 路径 hardcode 自 homedir()/Library/LaunchAgents/com.svcctl.supervisor.plist
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";

const isMac = process.platform === "darwin";
const describeMac = isMac ? describe : describe.skip;

describeMac("installMacOS — 全新 install 路径", () => {
  let tempHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "svcctl-install-macos-test-home-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  test("generatePlist 不含 SVCCTL_HOME", async () => {
    const { generatePlist } = await import("../src/install/macos");
    const plist = generatePlist("/tmp/fake/svcctl.js");
    expect(plist).not.toContain("SVCCTL_HOME");
  });

  test("generatePlist 不含 EnvironmentVariables dict", async () => {
    const { generatePlist } = await import("../src/install/macos");
    const plist = generatePlist("/tmp/fake/svcctl.js");
    expect(plist).not.toContain("EnvironmentVariables");
  });

  test("generatePlist 含正确 ProgramArguments / RunAtLoad / KeepAlive", async () => {
    const { generatePlist } = await import("../src/install/macos");
    const plist = generatePlist("/tmp/fake/svcctl.js");
    expect(plist).toContain("<string>bun</string>");
    expect(plist).toContain("<string>/tmp/fake/svcctl.js</string>");
    expect(plist).toContain("<string>_supervise</string>");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>Label</key><string>com.svcctl.supervisor</string>");
  });

  test("installMacOS: 写 plist + launchctl bootstrap + 写 installed.flag 不抛", async () => {
    const execSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      // 仅允许 launchctl 调用；记录即可不真跑
      if (typeof cmd === "string" && cmd.startsWith("launchctl")) {
        return Buffer.from("");
      }
      throw new Error(`unexpected execSync call: ${cmd}`);
    }) as typeof childProcess.execSync);

    try {
      const { installMacOS, plistPath } = await import("../src/install/macos");
      const { installedFlagPath } = await import("../src/paths");

      const expectedPlist = plistPath();          // = homedir()/Library/LaunchAgents/com.svcctl.supervisor.plist
      const expectedFlag = installedFlagPath();   // = homedir()/.local/state/svcctl/installed.flag

      expect(existsSync(expectedPlist)).toBe(false);
      expect(existsSync(expectedFlag)).toBe(false);

      expect(() => installMacOS({ cliPath: "/tmp/fake/svcctl.js" })).not.toThrow();

      expect(existsSync(expectedPlist)).toBe(true);
      expect(existsSync(expectedFlag)).toBe(true);

      // 关键断言：plist 文件内容不含 SVCCTL_HOME / EnvironmentVariables
      const plistContent = readFileSync(expectedPlist, "utf-8");
      expect(plistContent).not.toContain("SVCCTL_HOME");
      expect(plistContent).not.toContain("EnvironmentVariables");

      // installed.flag 内容 = plist file 路径
      const flagContent = readFileSync(expectedFlag, "utf-8");
      expect(flagContent).toBe(expectedPlist);

      // launchctl 被调过：bootstrap
      const calls = execSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes("bootstrap"))).toBe(true);
    } finally {
      execSpy.mockRestore();
    }
  });

  test("uninstallMacOS: 删 plist + flag，幂等（不抛）", async () => {
    const execSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      if (typeof cmd === "string" && cmd.startsWith("launchctl")) {
        return Buffer.from("");
      }
      throw new Error(`unexpected execSync call: ${cmd}`);
    }) as typeof childProcess.execSync);

    try {
      const { installMacOS, uninstallMacOS, plistPath } = await import("../src/install/macos");
      const { installedFlagPath } = await import("../src/paths");

      installMacOS({ cliPath: "/tmp/fake/svcctl.js" });

      const expectedPlist = plistPath();
      const expectedFlag = installedFlagPath();
      expect(existsSync(expectedPlist)).toBe(true);
      expect(existsSync(expectedFlag)).toBe(true);

      expect(() => uninstallMacOS()).not.toThrow();

      expect(existsSync(expectedPlist)).toBe(false);
      expect(existsSync(expectedFlag)).toBe(false);

      // 第二次跑应该也幂等不抛
      expect(() => uninstallMacOS()).not.toThrow();
    } finally {
      execSpy.mockRestore();
    }
  });

  test("重复 installMacOS: 不重建已存在的目录也不报错", async () => {
    const execSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      if (typeof cmd === "string" && cmd.startsWith("launchctl")) {
        // 模拟「已 bootstrap」失败，让它走 bootout → bootstrap 路径
        if (cmd.includes("bootstrap")) {
          throw new Error("already bootstrapped");
        }
        return Buffer.from("");
      }
      throw new Error(`unexpected execSync call: ${cmd}`);
    }) as typeof childProcess.execSync);

    try {
      const { installMacOS } = await import("../src/install/macos");
      installMacOS({ cliPath: "/tmp/fake/svcctl.js" });
      // 第二次跑：plist / flag 已在；都该幂等
      expect(() => installMacOS({ cliPath: "/tmp/fake/svcctl.js" })).not.toThrow();
    } finally {
      execSpy.mockRestore();
    }
  });
});