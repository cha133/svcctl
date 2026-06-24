/**
 * v0.5.x: installWindows 在全新机器上不抛 ENOENT 写 installed.flag
 *
 * 关键约束：
 * 1. 仅 Windows（process.platform === "win32"）
 * 2. XDG_* env 指向空 temp dir（全新 install 模拟）
 * 3. mock 掉 setWindowsRunKey/removeWindowsRunKey——不污染真注册表
 * 4. bundled = 真 bin/SvcCtl.exe（upgrade-windows.test.ts 同款 trick）
 *
 * 之前 bug：writeFileSync(installedFlagPath(),...) 没建 XDG_STATE_HOME/svcctl/ 父目录
 *          → fresh box 上 ENOENT。现在 installWindows 在写 flag 前调 ensureStateDir()。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 关掉 XDG migration（这文件只测 install 本身）
process.env.SVCCTL_NO_MIGRATE = "1";

const isWin = process.platform === "win32";
const describeWin = isWin ? describe : describe.skip;

describeWin("installWindows — 全新 install 路径", () => {
  let tempHome: string;
  let tempXdgRoot: string;
  let tempConfigHome: string;
  let tempDataHome: string;
  let tempStateHome: string;

  let savedUserProfile: string | undefined;
  let savedHomeDrive: string | undefined;
  let savedXdgConfig: string | undefined;
  let savedXdgData: string | undefined;
  let savedXdgState: string | undefined;

  let bundledPath: string;
  let realSvcCtl: string;
  let setRunKeySpy: ReturnType<typeof spyOn> | undefined;
  let removeRunKeySpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    savedUserProfile = process.env.USERPROFILE;
    savedHomeDrive = process.env.HOMEDRIVE;
    savedXdgConfig = process.env.XDG_CONFIG_HOME;
    savedXdgData = process.env.XDG_DATA_HOME;
    savedXdgState = process.env.XDG_STATE_HOME;

    tempHome = mkdtempSync(join(tmpdir(), "svcctl-install-test-home-"));
    tempXdgRoot = mkdtempSync(join(tmpdir(), "svcctl-install-test-xdg-"));
    tempConfigHome = join(tempXdgRoot, "config");
    tempDataHome = join(tempXdgRoot, "data");
    tempStateHome = join(tempXdgRoot, "state");

    process.env.USERPROFILE = tempHome;
    process.env.HOMEDRIVE = tempHome[0] + ":";
    process.env.XDG_CONFIG_HOME = tempConfigHome;
    process.env.XDG_DATA_HOME = tempDataHome;
    process.env.XDG_STATE_HOME = tempStateHome;

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
    if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdgConfig;
    if (savedXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdgData;
    if (savedXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdgState;

    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
    try { rmSync(tempXdgRoot, { recursive: true, force: true }); } catch {}
  });

  test("pre-call：XDG_STATE_HOME/svcctl 不存在（证明是全新环境）", () => {
    expect(existsSync(join(tempStateHome, "svcctl"))).toBe(false);
  });

  test("installWindows: 写 supervisor + 调 setRunKey + 写 installed.flag 不抛", async () => {
    const { installWindows } = await import("../src/install/windows");
    const {
      windowsSupervisorPath,
      windowsSupervisorWrapperPath,
      installedFlagPath,
    } = await import("../src/paths");

    const expectedExe = windowsSupervisorPath();           // = XDG_DATA_HOME/svcctl/bin/SvcCtl.exe
    const expectedWrapper = windowsSupervisorWrapperPath(); // = XDG_DATA_HOME/svcctl/bin/svcctl-supervisor.cmd
    const expectedFlag = installedFlagPath();              // = XDG_STATE_HOME/svcctl/installed.flag

    expect(existsSync(expectedExe)).toBe(false);
    expect(existsSync(expectedFlag)).toBe(false);

    // 关键断言：之前 fresh box 上这步会抛 ENOENT；现在应该顺利走完
    expect(() => installWindows(bundledPath)).not.toThrow();

    expect(existsSync(expectedExe)).toBe(true);
    expect(existsSync(expectedWrapper)).toBe(true); // v0.5.2: wrapper 跟 .exe 同目录
    expect(existsSync(expectedFlag)).toBe(true);

    // v0.5.2: 注册表指向 wrapper（不是裸 .exe），boot 启动时 wrapper 设 XDG env
    expect(setRunKeySpy!.mock.calls.length).toBe(1);
    expect(setRunKeySpy!.mock.calls[0]?.[0]).toBe(expectedWrapper);

    // wrapper 内容包含 XDG env 设定
    const wrapperContent = readFileSync(expectedWrapper, "utf-8");
    expect(wrapperContent).toContain("XDG_STATE_HOME");
    expect(wrapperContent).toContain("XDG_CONFIG_HOME");

    // installed.flag 内容 = supervisor 路径（跟其他平台约定一致）
    const flagContent = readFileSync(expectedFlag, "utf-8");
    expect(flagContent).toBe(expectedExe);
  });

  test("uninstallWindows: 调 removeRunKey + 删 installed.flag + 删 .exe + 删 wrapper", async () => {
    const { installWindows, uninstallWindows } = await import("../src/install/windows");
    const {
      windowsSupervisorPath,
      windowsSupervisorWrapperPath,
      installedFlagPath,
    } = await import("../src/paths");

    installWindows(bundledPath);
    const expectedExe = windowsSupervisorPath();
    const expectedWrapper = windowsSupervisorWrapperPath();
    const expectedFlag = installedFlagPath();
    expect(existsSync(expectedFlag)).toBe(true);
    expect(existsSync(expectedExe)).toBe(true);
    expect(existsSync(expectedWrapper)).toBe(true);

    uninstallWindows();

    expect(removeRunKeySpy!.mock.calls.length).toBe(1);
    expect(existsSync(expectedFlag)).toBe(false);
    expect(existsSync(expectedExe)).toBe(false);
    expect(existsSync(expectedWrapper)).toBe(false);
  });

  test("重复 installWindows: 不重建已存在的目录也不报错", async () => {
    const { installWindows } = await import("../src/install/windows");
    installWindows(bundledPath);
    // 第二次跑：state dir 已在、supervisor 已在；都该幂等
    expect(() => installWindows(bundledPath)).not.toThrow();
  });
});
