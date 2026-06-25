/**
 * v0.5.5: installLinux 在全新机器上写 unit + flag，不抛 ENOENT
 *
 * 关键约束：
 * 1. 仅 Linux（process.platform === "linux"）
 * 2. HOME 指向空 temp dir（全新 install 模拟）
 * 3. mock 掉 execSync——不真调 systemctl
 *
 * 验证 v0.5.5 简化：
 * - 生成的 unit 不含 `Environment=SVCCTL_HOME=...`
 * - 生成的 unit 不含 `XDG_STATE_HOME` / `XDG_CONFIG_HOME`
 * - 路径 hardcode 自 homedir()/.config/systemd/user/svcctl.service
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

const isLinux = process.platform === "linux";
const describeLinux = isLinux ? describe : describe.skip;

describeLinux("installLinux — 全新 install 路径", () => {
  let tempHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "svcctl-install-linux-test-home-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  test("generateUnit 不含 SVCCTL_HOME env", async () => {
    const { generateUnit } = await import("../src/install/linux");
    const unit = generateUnit("/tmp/fake/svcctl.js");
    expect(unit).not.toContain("SVCCTL_HOME");
  });

  test("generateUnit 不含 XDG_STATE_HOME / XDG_CONFIG_HOME", async () => {
    const { generateUnit } = await import("../src/install/linux");
    const unit = generateUnit("/tmp/fake/svcctl.js");
    expect(unit).not.toContain("XDG_STATE_HOME");
    expect(unit).not.toContain("XDG_CONFIG_HOME");
    expect(unit).not.toContain("XDG_DATA_HOME");
  });

  test("generateUnit 含正确 ExecStart / Restart / WantedBy", async () => {
    const { generateUnit } = await import("../src/install/linux");
    const unit = generateUnit("/tmp/fake/svcctl.js");
    expect(unit).toContain("ExecStart=/usr/bin/env bun run /tmp/fake/svcctl.js _supervise");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("installLinux: 写 unit + systemctl enable + 写 installed.flag 不抛", async () => {
    // mock execSync 拦截 systemctl 调用
    const execSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      // 仅允许 systemctl 系调用；记录即可不真跑
      if (typeof cmd === "string" && cmd.startsWith("systemctl")) {
        return Buffer.from("");
      }
      throw new Error(`unexpected execSync call: ${cmd}`);
    }) as typeof childProcess.execSync);

    try {
      const { installLinux, unitPath } = await import("../src/install/linux");
      const { installedFlagPath } = await import("../src/paths");

      const expectedUnit = unitPath();             // = homedir()/.config/systemd/user/svcctl.service
      const expectedFlag = installedFlagPath();    // = homedir()/.local/state/svcctl/installed.flag

      expect(existsSync(tempHome)).toBe(true);
      expect(existsSync(expectedUnit)).toBe(false);
      expect(existsSync(expectedFlag)).toBe(false);

      expect(() => installLinux({ cliPath: "/tmp/fake/svcctl.js" })).not.toThrow();

      expect(existsSync(expectedUnit)).toBe(true);
      expect(existsSync(expectedFlag)).toBe(true);

      // 关键断言：unit 文件内容不含 SVCCTL_HOME
      const unitContent = readFileSync(expectedUnit, "utf-8");
      expect(unitContent).not.toContain("SVCCTL_HOME");
      expect(unitContent).not.toContain("XDG_");

      // installed.flag 内容 = unit file 路径
      const flagContent = readFileSync(expectedFlag, "utf-8");
      expect(flagContent).toBe(expectedUnit);

      // systemctl 被调过：daemon-reload + enable --now
      const calls = execSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes("daemon-reload"))).toBe(true);
      expect(calls.some((c) => c.includes("enable"))).toBe(true);
    } finally {
      execSpy.mockRestore();
    }
  });

  test("uninstallLinux: 删 unit + flag，幂等（不抛）", async () => {
    const execSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      if (typeof cmd === "string" && cmd.startsWith("systemctl")) {
        return Buffer.from("");
      }
      throw new Error(`unexpected execSync call: ${cmd}`);
    }) as typeof childProcess.execSync);

    try {
      const { installLinux, uninstallLinux, unitPath } = await import("../src/install/linux");
      const { installedFlagPath } = await import("../src/paths");

      installLinux({ cliPath: "/tmp/fake/svcctl.js" });

      const expectedUnit = unitPath();
      const expectedFlag = installedFlagPath();
      expect(existsSync(expectedUnit)).toBe(true);
      expect(existsSync(expectedFlag)).toBe(true);

      expect(() => uninstallLinux()).not.toThrow();

      expect(existsSync(expectedUnit)).toBe(false);
      expect(existsSync(expectedFlag)).toBe(false);

      // 第二次跑应该也幂等不抛
      expect(() => uninstallLinux()).not.toThrow();
    } finally {
      execSpy.mockRestore();
    }
  });

  test("重复 installLinux: 不重建已存在的目录也不报错", async () => {
    const execSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      if (typeof cmd === "string" && cmd.startsWith("systemctl")) {
        return Buffer.from("");
      }
      throw new Error(`unexpected execSync call: ${cmd}`);
    }) as typeof childProcess.execSync);

    try {
      const { installLinux } = await import("../src/install/linux");
      installLinux({ cliPath: "/tmp/fake/svcctl.js" });
      // 第二次跑：unit / flag 已在；都该幂等
      expect(() => installLinux({ cliPath: "/tmp/fake/svcctl.js" })).not.toThrow();
    } finally {
      execSpy.mockRestore();
    }
  });
});