/**
 * upgradeWindowsSupervisor 的端到端测试
 *
 * 关键约束：
 * 1. 仅 Windows（process.platform === "win32"）
 * 2. 用 process.env.USERPROFILE 覆盖 home dir 指向 temp
 * 3. 模拟 supervisor 跑：用当前进程 pid 写入 supervisor.pid
 *    （process.kill(pid, 0) 对自己永远成功）
 * 4. bundled 二进制用 temp 里的小文件，不依赖真实 SvcCtl.exe
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";
const describeWin = isWin ? describe : describe.skip;

describeWin("upgradeWindowsSupervisor", () => {
  let tempHome: string;
  let originalUserProfile: string | undefined;
  let bundledPath: string;

  beforeEach(() => {
    originalUserProfile = process.env.USERPROFILE;
    // 用短路径避免 Windows MAX_PATH 限制
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

    // bundled 二进制用一个 dummy 文件（function 只检查 existsSync）
    bundledPath = join(tempHome, "bundled-SvcCtl.exe");
    writeFileSync(bundledPath, "fake-bundled-binary-v0.4.2", "utf-8");

    // dest 二进制（用 bundled 复制）
    copyFileSync(bundledPath, join(binDir, "SvcCtl.exe"));
  });

  afterEach(() => {
    process.env.USERPROFILE = originalUserProfile;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  test("version matches → up-to-date (no work done)", async () => {
    const { upgradeWindowsSupervisor } = await import("../src/install/windows");
    // supervisor.version 与 package.json 的 version 一致
    const { currentVersion } = await import("../src/install/windows");
    writeFileSync(
      join(tempHome, ".svcctl", "supervisor.version"),
      currentVersion(),
      "utf-8",
    );
    const result = await upgradeWindowsSupervisor(bundledPath);
    expect(result).toBe("up-to-date");
  });

  test("version mismatch + supervisor NOT running → upgraded", async () => {
    const { upgradeWindowsSupervisor } = await import("../src/install/windows");
    // 删掉 supervisor.pid 让 isSupervisorRunning 返回 false
    rmSync(join(tempHome, ".svcctl", "supervisor.pid"));
    // 写一个旧版本号
    writeFileSync(
      join(tempHome, ".svcctl", "supervisor.version"),
      "0.0.1-old",
      "utf-8",
    );
    const result = await upgradeWindowsSupervisor(bundledPath);
    expect(result).toBe("upgraded");
    // 验证版本戳更新了
    const stamp = readFileSync(join(tempHome, ".svcctl", "supervisor.version"), "utf-8");
    const { currentVersion } = await import("../src/install/windows");
    expect(stamp).toBe(currentVersion());
  });

  test("version mismatch + supervisor running → needs-restart (with .old → .old.stale rename)", async () => {
    const { upgradeWindowsSupervisor } = await import("../src/install/windows");
    // 写一个旧版本号
    writeFileSync(
      join(tempHome, ".svcctl", "supervisor.version"),
      "0.0.1-old",
      "utf-8",
    );
    // supervisor.pid 已经在 beforeEach 里写好（当前进程 pid）
    const result = await upgradeWindowsSupervisor(bundledPath);
    expect(result).toBe("needs-restart");
    // 验证 dest 被重新 copy 了
    const destContent = readFileSync(
      join(tempHome, ".svcctl", "bin", "SvcCtl.exe"),
      "utf-8",
    );
    expect(destContent).toBe("fake-bundled-binary-v0.4.2");
    // 验证版本戳更新了
    const stamp = readFileSync(join(tempHome, ".svcctl", "supervisor.version"), "utf-8");
    const { currentVersion } = await import("../src/install/windows");
    expect(stamp).toBe(currentVersion());
  });

  test("version mismatch + supervisor running + .old 残留 → unlink .old，不创建 .old.stale", async () => {
    const { upgradeWindowsSupervisor, currentVersion } = await import("../src/install/windows");
    // 模拟上一次升级残留：只有 .old（v0.4.4 stop 正确杀进程树，不再需要 .old.stale）
    const oldPath = join(tempHome, ".svcctl", "bin", "SvcCtl.exe.old");
    writeFileSync(oldPath, "previous-old-binary", "utf-8");
    // 写一个旧版本号
    writeFileSync(
      join(tempHome, ".svcctl", "supervisor.version"),
      "0.0.1-old",
      "utf-8",
    );

    const result = await upgradeWindowsSupervisor(bundledPath);
    expect(result).toBe("needs-restart");

    // .old 现在存在（步骤 2 rename dest → .old 的结果），内容是旧的 bundled
    // （升级前 dest 被 copy 成 bundled 的内容，所以新旧一样，但重要的是 .old 文件存在）
    const { existsSync } = await import("node:fs");
    expect(existsSync(oldPath)).toBe(true);

    // .old.stale 不会被创建
    const stalePath = join(tempHome, ".svcctl", "bin", "SvcCtl.exe.old.stale");
    expect(existsSync(stalePath)).toBe(false);

    // 验证 dest 是新的 bundled 内容
    const destContent = readFileSync(
      join(tempHome, ".svcctl", "bin", "SvcCtl.exe"),
      "utf-8",
    );
    expect(destContent).toBe("fake-bundled-binary-v0.4.2");

    // 验证版本戳更新了
    const stamp = readFileSync(join(tempHome, ".svcctl", "supervisor.version"), "utf-8");
    expect(stamp).toBe(currentVersion());
  });
});
