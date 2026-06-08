import { parseTOML, stringifyTOML } from "confbox";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configTomlPath, svcctlDir } from "./paths";

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

/** 写 ~/.svcctl/config.toml（原子写） */
export function saveConfig(config: SvcctlConfig): void {
  const path = configTomlPath();
  mkdirSync(dirname(path), { recursive: true });
  const merged: Required<SvcctlConfig> = { ...DEFAULT_CONFIG, ...config };
  writeFileSync(path, stringifyTOML(merged), "utf-8");
}

/** 拿到 home dir（logDir 展开用） */
export function homeDir(): string {
  return svcctlDir().replace(/[\\/][^\\/]+$/, ""); // 取父目录即 homedir()
}
