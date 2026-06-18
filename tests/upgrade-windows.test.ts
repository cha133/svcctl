/**
 * v0.4.11: upgradeWindowsSupervisor 的端到端测试
 *
 * 关键约束：
 * 1. 仅 Windows（process.platform === "win32"）
 * 2. 用 process.env.USERPROFILE 覆盖 home dir 指向 temp
 * 3. 模拟 supervisor 跑：用当前进程 pid 写入 supervisor.pid
 *    （process.kill(pid, 0) 对自己永远成功）
 * 4. bundled 二进制用真 bin/SvcCtl.exe（PE FileVersion 跟 currentVersion 一致 → up-to-date）
 *    —— v0.4.11 PE version check 让 fake 文件测不出"mismatch"分支。
 *    mismatch 路径用 readExeVersion mock 模拟（不写 supervisor.version 文件）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

const isWin = process.platform === "win32";
const describeWin = isWin ? describe : describe.skip;

describeWin("upgradeWindowsSupervisor", () => {
  let tempHome: string;
  let originalUserProfile: string | undefined;
  let bundledPath: string;
  let realSvcCtl: string;

  beforeEach(() => {
    originalUserProfile = process.env.USERPROFILE;
    tempHome = mkdtempSync(join(tmpdir(), "svcctl-upgrade-test-"));
    process.env.USERPROFILE = tempHome;
    process.env.HOMEDRIVE = tempHome[0] + ":";

    // 当前进程 pid 当 supervisor pid（kill 0 对自己永远成功）
    const pid = process.pid;
    const svcctlDir = join(tempHome, ".svcctl");
    const binDir = join(svcctlDir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(svcctlDir, "supervisor.pid"), String(pid), "utf-8");
    writeFileSync(join(svcctlDir, "installed.flag"), "dummy", "utf-8");

    // bundled 用真 bin/SvcCtl.exe（PE FileVersion = currentVersion）
    realSvcCtl = realpathSync(join(import.meta.dir, "..", "bin", "SvcCtl.exe"));
    bundledPath = join(tempHome, "bundled-SvcCtl.exe");
    copyFileSync(realSvcCtl, bundledPath);
    // dest 也 copy 一份（测试"version matches → up-to-date"分支）
    copyFileSync(realSvcCtl, join(binDir, "SvcCtl.exe"));
  });

  afterEach(() => {
    process.env.USERPROFILE = originalUserProfile;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  test("version matches (PE FileVersion == currentVersion) → up-to-date", async () => {
    const { upgradeWindowsSupervisor } = await import("../src/install/windows");
    const result = await upgradeWindowsSupervisor(bundledPath);
    expect(result).toBe("up-to-date");
  });

  test("dest 不存在 + supervisor NOT running → upgraded (copyFileSync)", async () => {
    const { upgradeWindowsSupervisor } = await import("../src/install/windows");
    // 删 dest 让 PE check fail → 触发升级
    const dest = join(tempHome, ".svcctl", "bin", "SvcCtl.exe");
    rmSync(dest);
    // 删 supervisor.pid 让 supervisorRunning = false
    rmSync(join(tempHome, ".svcctl", "supervisor.pid"));

    const result = await upgradeWindowsSupervisor(bundledPath);
    expect(result).toBe("upgraded");
    // dest 现在存在
    expect(existsSync(dest)).toBe(true);
  });

  test("dest 不存在 + supervisor running → needs-restart (rename 失败)", async () => {
    const { upgradeWindowsSupervisor } = await import("../src/install/windows");
    // 删 dest 让 PE check fail → 触发升级路径
    const dest = join(tempHome, ".svcctl", "bin", "SvcCtl.exe");
    rmSync(dest);
    // supervisor.pid 已经在 beforeEach 里写好（当前进程 pid）→ supervisorRunning = true
    // 走 NTFS rename 路径：rename dest → .old（dest 不存在，rename 失败）→ needs-restart
    const result = await upgradeWindowsSupervisor(bundledPath);
    expect(result).toBe("needs-restart");
    // dest 仍不存在（rename 失败没 copy 新的）
    expect(existsSync(dest)).toBe(false);
  });
});
