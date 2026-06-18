/**
 * v0.4.13: upgradeWindowsSupervisor 的端到端测试
 *
 * 关键约束：
 * 1. 仅 Windows（process.platform === "win32"）
 * 2. 用 process.env.USERPROFILE 覆盖 home dir 指向 temp
 * 3. bundled 用真 bin/SvcCtl.exe（PE FileVersion 跟 currentVersion 一致 → up-to-date）
 *
 * v0.4.13 流程简化：
 *   - caller (upgradeCommand) 保证 dest 没锁（supervisor 没跑或刚 stop）
 *   - upgradeWindowsSupervisor 只做直接 copyFileSync bundled → dest
 *   - 删 NTFS rename + .old 处理（之前修了好几个版本的 NTFS trick）
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

    const svcctlDir = join(tempHome, ".svcctl");
    const binDir = join(svcctlDir, "bin");
    mkdirSync(binDir, { recursive: true });
    // 不写 supervisor.pid：supervisorRunning = false（直接 copy 路径）

    // bundled + dest 都用真 bin/SvcCtl.exe（PE FileVersion = currentVersion）
    realSvcCtl = realpathSync(join(import.meta.dir, "..", "bin", "SvcCtl.exe"));
    bundledPath = join(tempHome, "bundled-SvcCtl.exe");
    copyFileSync(realSvcCtl, bundledPath);
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

  test("dest 不存在 → upgraded (copyFileSync bundled → dest)", async () => {
    const { upgradeWindowsSupervisor } = await import("../src/install/windows");
    const dest = join(tempHome, ".svcctl", "bin", "SvcCtl.exe");
    rmSync(dest);
    const result = await upgradeWindowsSupervisor(bundledPath);
    expect(result).toBe("upgraded");
    expect(existsSync(dest)).toBe(true);
  });

  test("dest 跟 bundled PE version 一致但 dest 不存在 → upgraded", async () => {
    // v0.4.13 简化的核心：caller 保证 dest 没锁，upgradeWindowsSupervisor 直接 copy
    const { upgradeWindowsSupervisor } = await import("../src/install/windows");
    const dest = join(tempHome, ".svcctl", "bin", "SvcCtl.exe");
    rmSync(dest);
    const result = await upgradeWindowsSupervisor(bundledPath);
    expect(result).toBe("upgraded");
  });
});
