/**
 * v0.5.x: installWindows 在全新机器上不抛 ENOENT 写 installed.flag
 *
 * 关键约束：
 * 1. 仅 Windows（process.platform === "win32"）
 * 2. USERPROFILE / HOMEDRIVE 指向空 temp dir（全新 install 模拟）
 * 3. mock 掉 setWindowsRunKey/removeWindowsRunKey——不污染真注册表
 * 4. bundled = 真 bin/SvcCtl.exe（upgrade-windows.test.ts 同款 trick）
 *
 * 之前 bug：writeFileSync(installedFlagPath(),...) 没建 homedir()/.local/state/svcctl/ 父目录
 *          → fresh box 上 ENOENT。现在 installWindows 在写 flag 前调 ensureStateDir()。
 *
 * v0.5.5: 全平台路径 hardcode 自 homedir()/.local/state/svcctl，删 XDG env 注入。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";
const describeWin = isWin ? describe : describe.skip;

describeWin("installWindows — 全新 install 路径", () => {
  let tempHome: string;

  let savedUserProfile: string | undefined;
  let savedHomeDrive: string | undefined;

  let bundledPath: string;
  let realSvcCtl: string;
  let setRunKeySpy: ReturnType<typeof spyOn> | undefined;
  let removeRunKeySpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    savedUserProfile = process.env.USERPROFILE;
    savedHomeDrive = process.env.HOMEDRIVE;

    tempHome = mkdtempSync(join(tmpdir(), "svcctl-install-test-home-"));
    process.env.USERPROFILE = tempHome;
    process.env.HOMEDRIVE = tempHome[0] + ":";

    // 复制真 SvcCtl.exe 作 bundled
    realSvcCtl = realpathSync(join(import.meta.dir, "..", "bin", "SvcCtl.exe"));
    bundledPath = join(tempHome, "bundled-SvcCtl.exe");
    copyFileSync(realSvcCtl, bundledPath);

    // 动态 import 让上面的 env 在模块加载时生效
    const win = await import("../src/install/windows");
    setRunKeySpy = spyOn(win, "setWindowsRunKey").mockImplementation(() => {});
    removeRunKeySpy = spyOn(win, "removeWindowsRunKey").mockImplementation(() => {});
  });

  afterEach(() => {
    if (setRunKeySpy) setRunKeySpy.mockRestore();
    if (removeRunKeySpy) removeRunKeySpy.mockRestore();

    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedHomeDrive === undefined) delete process.env.HOMEDRIVE;
    else process.env.HOMEDRIVE = savedHomeDrive;

    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  test("pre-call：homedir()/.local/state/svcctl 不存在（证明是全新环境）", () => {
    expect(existsSync(join(tempHome, ".local", "state", "svcctl"))).toBe(false);
  });

  test("installWindows: 写 supervisor + 调 setRunKey + 写 installed.flag 不抛", async () => {
    const { installWindows } = await import("../src/install/windows");
    const {
      windowsSupervisorPath,
      installedFlagPath,
    } = await import("../src/paths");

    const expectedExe = windowsSupervisorPath();           // = homedir()/.local/share/svcctl/bin/SvcCtl.exe
    const expectedFlag = installedFlagPath();              // = homedir()/.local/state/svcctl/installed.flag

    expect(existsSync(expectedExe)).toBe(false);
    expect(existsSync(expectedFlag)).toBe(false);

    // 关键断言：之前 fresh box 上这步会抛 ENOENT；现在应该顺利走完
    expect(() => installWindows(bundledPath)).not.toThrow();

    expect(existsSync(expectedExe)).toBe(true);
    expect(existsSync(expectedFlag)).toBe(true);

    // v0.5.4: 注册表直接指向 .exe（不再用 .cmd wrapper，Rust 端 hardcode Windows 路径）
    expect(setRunKeySpy!.mock.calls.length).toBe(1);
    expect(setRunKeySpy!.mock.calls[0]?.[0]).toBe(expectedExe);

    // installed.flag 内容 = supervisor 路径（跟其他平台约定一致）
    const flagContent = readFileSync(expectedFlag, "utf-8");
    expect(flagContent).toBe(expectedExe);
  });

  test("uninstallWindows: 调 removeRunKey + 删 installed.flag + 删 .exe", async () => {
    const { installWindows, uninstallWindows } = await import("../src/install/windows");
    const {
      windowsSupervisorPath,
      installedFlagPath,
    } = await import("../src/paths");

    installWindows(bundledPath);
    const expectedExe = windowsSupervisorPath();
    const expectedFlag = installedFlagPath();
    expect(existsSync(expectedFlag)).toBe(true);
    expect(existsSync(expectedExe)).toBe(true);

    uninstallWindows();

    expect(removeRunKeySpy!.mock.calls.length).toBe(1);
    expect(existsSync(expectedFlag)).toBe(false);
    expect(existsSync(expectedExe)).toBe(false);
  });

  test("重复 installWindows: 不重建已存在的目录也不报错", async () => {
    const { installWindows } = await import("../src/install/windows");
    installWindows(bundledPath);
    // 第二次跑：state dir 已在、supervisor 已在；都该幂等
    expect(() => installWindows(bundledPath)).not.toThrow();
  });

  test("v0.5.4 升级：bin 下有 v0.5.3 残留 wrapper，install 后清掉", async () => {
    const { installWindows } = await import("../src/install/windows");
    const {
      windowsSupervisorPath,
      installedFlagPath,
    } = await import("../src/paths");
    const { dirname, join } = await import("node:path");
    const { mkdirSync } = await import("node:fs");

    // 模拟 v0.5.3 残留：在 bin/ 里放一个假的 svcctl-supervisor.cmd
    // 先建 bin/（v0.5.4 fresh install 时 bin/ 是 install 内部建的，但残留 wrapper
    // 场景下 bin/ 已经在，所以直接建出来没问题）
    const bin = dirname(windowsSupervisorPath());
    mkdirSync(bin, { recursive: true });
    const staleWrapper = join(bin, "svcctl-supervisor.cmd");
    writeFileSync(staleWrapper, "@echo off\r\nREM fake v0.5.3 wrapper\r\n", "utf-8");
    expect(existsSync(staleWrapper)).toBe(true);

    expect(() => installWindows(bundledPath)).not.toThrow();

    // v0.5.4 install 后残留 wrapper 应被清掉
    expect(existsSync(staleWrapper)).toBe(false);
    // 注册表指向 .exe，不是 wrapper
    expect(setRunKeySpy!.mock.calls[0]?.[0]).toBe(windowsSupervisorPath());
    // flag 也写好了
    expect(existsSync(installedFlagPath())).toBe(true);
  });

  test("v0.5.3 → v0.5.4：uninstall 也清残留 wrapper", async () => {
    const { installWindows, uninstallWindows } = await import("../src/install/windows");
    const { windowsSupervisorPath } = await import("../src/paths");
    const { dirname, join } = await import("node:path");

    installWindows(bundledPath);
    // 模拟 v0.5.3 wrapper 在 install 后又被写回（实际不会发生，但覆盖 uninstall 清理分支）
    const bin = dirname(windowsSupervisorPath());
    const staleWrapper = join(bin, "svcctl-supervisor.cmd");
    writeFileSync(staleWrapper, "@echo off\r\nREM stale\r\n", "utf-8");
    expect(existsSync(staleWrapper)).toBe(true);

    uninstallWindows();

    expect(existsSync(staleWrapper)).toBe(false);
    expect(existsSync(windowsSupervisorPath())).toBe(false);
  });
});