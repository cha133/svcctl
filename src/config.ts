import { parseTOML, stringifyTOML } from "confbox";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { configTomlPath } from "./paths";

/** 全局配置 shape */
export interface SvcctlConfig {
  /** 子进程重启退避（ms），默认 1000 */
  restartBackoffMs?: number;
  /** 子进程 reap 间隔（ms），默认 1000 */
  reapIntervalMs?: number;
  /** per-entry log 目录，默认 ~/.svcctl/logs */
  logDir?: string;
}

const DEFAULT_CONFIG: Required<SvcctlConfig> = {
  restartBackoffMs: 1000,
  reapIntervalMs: 1000,
  logDir: "~/.svcctl/logs",
};

/** 读 ~/.svcctl/config.toml，不存在则返回默认值 */
export function loadConfig(): Required<SvcctlConfig> {
  const path = configTomlPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = parseTOML(raw) as SvcctlConfig;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    // 解析失败退回默认值（不阻塞主流程）
    return { ...DEFAULT_CONFIG };
  }
}

/** 写 ~/.config/svcctl/config.toml（原子写：tmp + rename） */
export function saveConfig(config: SvcctlConfig): void {
  const path = configTomlPath();
  mkdirSync(dirname(path), { recursive: true });
  const merged: Required<SvcctlConfig> = { ...DEFAULT_CONFIG, ...config };
  const tmp = join(tmpdir(), `svcctl-config-${process.pid}-${Date.now()}.toml`);
  writeFileSync(tmp, stringifyTOML(merged), "utf-8");
  renameSync(tmp, path);
}

/** 拿到 home dir（logDir 展开用） */
export function homeDir(): string {
  return homedir();
}
