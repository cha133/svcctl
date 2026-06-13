/** 单条 entry —— ~/.svcctl/entries.toml 里的一条记录 */
export interface Entry {
  /** slug；entry 内唯一 */
  name: string;
  /** exec head（"bun" / "node" / "/usr/local/bin/foo" / "C:\\..."） */
  command: string;
  /** argv tail */
  args: string[];
  /** 可选工作目录，默认 homedir() */
  cwd?: string;
  /** 可选 env 增量 */
  env?: Record<string, string>;
  /** ISO-8601，add 时自动填 */
  createdAt: string;
  /** 是否开机自启（默认 true）。false = 仅手动 start */
  startup?: boolean;
  /** 可选 healthcheck URL（v1 status 暂不读，先留字段） */
  healthcheckUrl?: string;
}

/** entries.toml 顶层结构 */
export interface EntriesFile {
  /** schema 版本，便于将来迁移 */
  version: number;
  entries: Entry[];
}

export const ENTRIES_VERSION = 1;

/** 空文件默认值 */
export function emptyEntriesFile(): EntriesFile {
  return { version: ENTRIES_VERSION, entries: [] };
}
