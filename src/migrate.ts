// ============================================================================
// svcctl schema/layout migrations
// ----------------------------------------------------------------------------
// 每次 layout 改变加一个 entry 进 MIGRATIONS 数组。runStartupMigrations() 检查
// entries.toml 的 version 字段，跑所有 pending migration。
//
// 跟 package.json version 无关——是 schema/layout 的 version。保留 3 个 svcctl
// 版本后（v0.8.0+）可删除本文件 + ENTRIES_VERSION 字段回滚 + runStartupMigrations 调用 +
// SVCCTL_NO_MIGRATE env var。
//
// 注：v0.4.15 → v0.5.0 ENTRIES_VERSION 从 1 改 2，触发 XDG migration。
// ============================================================================
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseTOML, stringifyTOML } from "confbox";
import { xdgConfigHome, xdgDataHome, xdgStateHome } from "./xdg";
import { entriesTomlPath, logsDir, supervisorLogPath, windowsSupervisorPath } from "./paths";
import { ENTRIES_VERSION } from "./entries/types";

interface Migration {
  version: number;
  /** file-moving / external-state migration */
  run: () => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    run: () =>
      migrateToXdg({
        oldHome: homedir(),
        newConfigHome: xdgConfigHome(),
        newDataHome: xdgDataHome(),
        newStateHome: xdgStateHome(),
      }),
  },
] as const;

/**
 * 在 svcctl 启动早期跑一次（loadEntriesAt 内部调）。幂等。
 *
 * 跳过条件：SVCCTL_NO_MIGRATE=1 / 没有任何 pending migration。
 * entries.toml 不存在 → no-op（全新 install）
 */
export function runStartupMigrations(): void {
  if (shouldSkip()) return;
  const entriesPath = entriesTomlPath();
  const current = readVersionFromDisk(entriesPath);
  const target = ENTRIES_VERSION;
  if (current >= target) return;

  for (const m of MIGRATIONS) {
    if (current < m.version) {
      try {
        m.run();
      } catch (e) {
        console.error(`⚠ svcctl migration to schema v${m.version} failed: ${(e as Error).message}`);
        return;
      }
    }
  }
  // 跑成功才 bump version
  bumpVersionOnDisk(entriesPath, target);
}

function shouldSkip(): boolean {
  if (process.env.SVCCTL_NO_MIGRATE === "1") return true;
  return false;
}

function readVersionFromDisk(entriesPath: string): number {
  if (!existsSync(entriesPath)) return 0;
  try {
    const data = parseTOML(readFileSync(entriesPath, "utf-8")) as { version?: number };
    return data.version ?? 0;
  } catch {
    return 0;
  }
}

function bumpVersionOnDisk(entriesPath: string, version: number): void {
  if (!existsSync(entriesPath)) return;
  let data: Record<string, unknown>;
  try {
    data = parseTOML(readFileSync(entriesPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return;
  }
  data.version = version;
  const tmp = `${entriesPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, stringifyTOML(data), "utf-8");
  renameSync(tmp, entriesPath);
}

/**
 * 暴露的纯函数版本（paths 注入）——测试用。
 */
export function migrateToXdg(params: {
  oldHome: string;
  newConfigHome: string;
  newDataHome: string;
  newStateHome: string;
}): void {
  const { oldHome, newConfigHome, newDataHome, newStateHome } = params;
  const old = join(oldHome, ".svcctl");
  if (!existsSync(old)) return; // 全新 install，无事可做

  const staging = `${old}.migrating-${process.pid}-${Date.now()}`;
  try {
    renameSync(old, staging);
  } catch (e) {
    throw new Error(`failed to rename ${old} → staging: ${(e as Error).message}`);
  }

  try {
    // 1. entries.toml → CONFIG
    const oldEntries = join(staging, "entries.toml");
    if (existsSync(oldEntries)) {
      const newDir = join(newConfigHome, "svcctl");
      mkdirSync(newDir, { recursive: true });
      copyFileSync(oldEntries, join(newDir, "entries.toml"));
      assertCopyMatches(oldEntries, join(newDir, "entries.toml"));
      // bump version
      bumpVersionOnDisk(join(newDir, "entries.toml"), 2);
      try {
        parseTOML(readFileSync(join(newDir, "entries.toml"), "utf-8"));
      } catch (e) {
        throw new Error(`migrated entries.toml is not valid TOML: ${(e as Error).message}`);
      }
    }

    // 2. config.toml → CONFIG
    const oldConfig = join(staging, "config.toml");
    if (existsSync(oldConfig)) {
      const newDir = join(newConfigHome, "svcctl");
      mkdirSync(newDir, { recursive: true });
      copyFileSync(oldConfig, join(newDir, "config.toml"));
      assertCopyMatches(oldConfig, join(newDir, "config.toml"));
      try {
        parseTOML(readFileSync(join(newDir, "config.toml"), "utf-8"));
      } catch (e) {
        throw new Error(`migrated config.toml is not valid TOML: ${(e as Error).message}`);
      }
    }

    // 3. logs/*.log → STATE
    const oldLogs = join(staging, "logs");
    if (existsSync(oldLogs)) {
      const newDir = logsDir();
      mkdirSync(newDir, { recursive: true });
      for (const name of readdirSync(oldLogs)) {
        const src = join(oldLogs, name);
        const dst = join(newDir, name);
        if (statSync(src).isFile()) {
          copyFileSync(src, dst);
          assertCopyMatches(src, dst);
        }
      }
    }

    // 4. supervisor.log → STATE
    const oldSupLog = join(staging, "supervisor.log");
    if (existsSync(oldSupLog)) {
      const newDir = join(newStateHome, "svcctl");
      mkdirSync(newDir, { recursive: true });
      const newPath = supervisorLogPath();
      copyFileSync(oldSupLog, newPath);
      assertCopyMatches(oldSupLog, newPath);
    }

    // 5. bin/SvcCtl.exe → DATA（关键！用户指定的非-PATH 位置）
    const oldExe = join(staging, "bin", "SvcCtl.exe");
    if (existsSync(oldExe)) {
      const newPath = windowsSupervisorPath();
      const newDir = join(newDataHome, "svcctl", "bin");
      mkdirSync(newDir, { recursive: true });
      copyFileSync(oldExe, newPath);
      assertCopyMatches(oldExe, newPath);
    }

    // 全部成功才删 staging
    rmSync(staging, { recursive: true, force: true });
    console.log(`✓ svcctl: migrated ~/.svcctl/ → XDG layout`);
  } catch (e) {
    console.error(`⚠ svcctl XDG migration failed: ${(e as Error).message}`);
    console.error(`  staging copy preserved at ${staging} for manual recovery`);
    console.error(`  to retry: rm -rf ~/.svcctl && mv '${staging}' ~/.svcctl && restart svcctl`);
    // staging 保留作 rollback
  }
}

function assertCopyMatches(src: string, dst: string): void {
  const s1 = statSync(src).size;
  const s2 = statSync(dst).size;
  if (s1 !== s2) {
    throw new Error(`size mismatch after copy: ${src} (${s1}B) vs ${dst} (${s2}B)`);
  }
}
