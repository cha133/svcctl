// ============================================================================
// XDG migration 测试
// ----------------------------------------------------------------------------
// 验证 ~/.svcctl/ → XDG layout 的搬移逻辑：
//   - entries.toml / config.toml → $XDG_CONFIG_HOME/svcctl/
//   - logs/*.log → $XDG_STATE_HOME/svcctl/logs/
//   - supervisor.log → $XDG_STATE_HOME/svcctl/supervisor.log
//   - bin/SvcCtl.exe → $XDG_DATA_HOME/svcctl/bin/SvcCtl.exe  ← 关键
//   - 老 dir 删
//   - 全新 install → no-op
//   - 二进制等大、parse 通过
// ============================================================================
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { migrateToXdg } from "../src/migrate";

// 关掉 XDG migration（这文件就是测 migration 本身的）
process.env.SVCCTL_NO_MIGRATE = "1";

let oldHome: string;
let newXdgRoot: string;
let newConfigHome: string;
let newDataHome: string;
let newStateHome: string;
let savedConfig: string | undefined;
let savedData: string | undefined;
let savedState: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  oldHome = mkdtempSync(join(tmpdir(), "svcctl-xdg-old-"));
  newXdgRoot = mkdtempSync(join(tmpdir(), "svcctl-xdg-new-"));
  newConfigHome = join(newXdgRoot, "config");
  newDataHome = join(newXdgRoot, "data");
  newStateHome = join(newXdgRoot, "state");

  savedConfig = process.env.XDG_CONFIG_HOME;
  savedData = process.env.XDG_DATA_HOME;
  savedState = process.env.XDG_STATE_HOME;
  savedHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = newConfigHome;
  process.env.XDG_DATA_HOME = newDataHome;
  process.env.XDG_STATE_HOME = newStateHome;
  process.env.HOME = oldHome;
});

afterEach(() => {
  if (oldHome) rmSync(oldHome, { recursive: true, force: true });
  if (newXdgRoot) rmSync(newXdgRoot, { recursive: true, force: true });
  if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfig;
  if (savedData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedData;
  if (savedState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedState;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

// v0.5.4: Windows 不再兼容 ~/.svcctl（路径定死在 %USERPROFILE%/.local/state 等），
// XDG 迁移是 Mac/Linux 概念。Windows 上 logsDir / supervisorLogPath / windowsSupervisorPath
// 不读 XDG_*_HOME env，所以这个测试在 Windows 上跑没意义。
const isWin = process.platform === "win32";
const describeSkipWin = isWin ? describe.skip : describe;

describeSkipWin("migrateToXdg", () => {
  test("全新 install：~/.svcctl/ 不存在 → no-op", () => {
    migrateToXdg({ oldHome, newConfigHome, newDataHome, newStateHome });
    expect(existsSync(join(newConfigHome, "svcctl"))).toBe(false);
    expect(existsSync(join(newDataHome, "svcctl", "bin", "SvcCtl.exe"))).toBe(false);
  });

  test("entries.toml 搬到 XDG_CONFIG_HOME/svcctl/，且 bump version=2", () => {
    const oldSvcctl = join(oldHome, ".svcctl");
    mkdirSync(oldSvcctl, { recursive: true });
    const oldEntries = join(oldSvcctl, "entries.toml");
    writeFileSync(
      oldEntries,
      `version = 1
[[entries]]
name = "test"
command = "echo"
args = ["hi"]
createdAt = "2026-01-01T00:00:00Z"
`,
    );

    migrateToXdg({ oldHome, newConfigHome, newDataHome, newStateHome });

    const newEntries = join(newConfigHome, "svcctl", "entries.toml");
    expect(existsSync(newEntries)).toBe(true);
    const data = parse(readFileSync(newEntries, "utf-8")) as { version: number; entries: Array<{ name: string }> };
    expect(data.version).toBe(2);
    expect(data.entries[0]?.name).toBe("test");

    expect(existsSync(oldSvcctl)).toBe(false);
  });

  test("config.toml 搬到 XDG_CONFIG_HOME/svcctl/", () => {
    const oldSvcctl = join(oldHome, ".svcctl");
    mkdirSync(oldSvcctl, { recursive: true });
    writeFileSync(join(oldSvcctl, "config.toml"), `restartBackoffMs = 2000\n`);

    migrateToXdg({ oldHome, newConfigHome, newDataHome, newStateHome });

    expect(existsSync(join(newConfigHome, "svcctl", "config.toml"))).toBe(true);
    expect(existsSync(oldSvcctl)).toBe(false);
  });

  test("logs/*.log 搬到 XDG_STATE_HOME/svcctl/logs/", () => {
    const oldSvcctl = join(oldHome, ".svcctl");
    const oldLogs = join(oldSvcctl, "logs");
    mkdirSync(oldLogs, { recursive: true });
    writeFileSync(join(oldLogs, "test.log"), "log content\n");
    writeFileSync(join(oldLogs, "test2.log"), "log2\n");

    migrateToXdg({ oldHome, newConfigHome, newDataHome, newStateHome });

    const newLogs = join(newStateHome, "svcctl", "logs");
    expect(existsSync(join(newLogs, "test.log"))).toBe(true);
    expect(existsSync(join(newLogs, "test2.log"))).toBe(true);
    expect(readFileSync(join(newLogs, "test.log"), "utf-8")).toBe("log content\n");
    expect(existsSync(oldSvcctl)).toBe(false);
  });

  test("supervisor.log 搬到 XDG_STATE_HOME/svcctl/supervisor.log", () => {
    const oldSvcctl = join(oldHome, ".svcctl");
    mkdirSync(oldSvcctl, { recursive: true });
    writeFileSync(join(oldSvcctl, "supervisor.log"), "sup started\n");

    migrateToXdg({ oldHome, newConfigHome, newDataHome, newStateHome });

    expect(existsSync(join(newStateHome, "svcctl", "supervisor.log"))).toBe(true);
    expect(readFileSync(join(newStateHome, "svcctl", "supervisor.log"), "utf-8")).toBe("sup started\n");
  });

  test("bin/SvcCtl.exe 搬到 XDG_DATA_HOME/svcctl/bin/（用户指定位置）", () => {
    const oldSvcctl = join(oldHome, ".svcctl");
    const oldBin = join(oldSvcctl, "bin");
    mkdirSync(oldBin, { recursive: true });
    // 用 1KB 假 binary 测：写入指定字节内容验证
    const fakeBinary = Buffer.alloc(1024, 0xab);
    writeFileSync(join(oldBin, "SvcCtl.exe"), fakeBinary);

    migrateToXdg({ oldHome, newConfigHome, newDataHome, newStateHome });

    const newExe = join(newDataHome, "svcctl", "bin", "SvcCtl.exe");
    expect(existsSync(newExe)).toBe(true);
    const newBin2 = readFileSync(newExe);
    expect(newBin2.length).toBe(1024);
    expect(newBin2[0]).toBe(0xab);
    expect(existsSync(oldSvcctl)).toBe(false);
  });

  test("全部文件一起迁 + 老 dir 完全清空", () => {
    const oldSvcctl = join(oldHome, ".svcctl");
    mkdirSync(oldSvcctl, { recursive: true });
    writeFileSync(join(oldSvcctl, "entries.toml"), `version = 1\n`);
    writeFileSync(join(oldSvcctl, "config.toml"), ``);
    mkdirSync(join(oldSvcctl, "logs"), { recursive: true });
    writeFileSync(join(oldSvcctl, "logs", "x.log"), "");
    writeFileSync(join(oldSvcctl, "supervisor.log"), "");
    mkdirSync(join(oldSvcctl, "bin"), { recursive: true });
    writeFileSync(join(oldSvcctl, "bin", "SvcCtl.exe"), "x");

    migrateToXdg({ oldHome, newConfigHome, newDataHome, newStateHome });

    expect(existsSync(join(newConfigHome, "svcctl", "entries.toml"))).toBe(true);
    expect(existsSync(join(newConfigHome, "svcctl", "config.toml"))).toBe(true);
    expect(existsSync(join(newStateHome, "svcctl", "logs", "x.log"))).toBe(true);
    expect(existsSync(join(newStateHome, "svcctl", "supervisor.log"))).toBe(true);
    expect(existsSync(join(newDataHome, "svcctl", "bin", "SvcCtl.exe"))).toBe(true);
    expect(existsSync(oldSvcctl)).toBe(false);
    // 没有 .migrating 残留
    const leftovers = readdirSync(oldHome).filter((n) => n.startsWith(".svcctl"));
    expect(leftovers).toEqual([]);
  });
});
