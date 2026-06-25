/** 单条 entry —— ~/.config/svcctl/entries.toml 里的一条记录 */
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
  /** v0.4.7: 子进程死了是否 opt-in 自动重启。默认 false —— 大部分程序内部都有
   *  全局 catch 不容易死，supervisor 兜底是额外复杂度；想要兜底就 entries.toml 加
   *  `restart = true` 或 `svcctl add --restart ...` */
  restart?: boolean;
  /** 可选 healthcheck URL（v1 status 暂不读，先留字段） */
  healthcheckUrl?: string;
}

/** entries.toml 顶层结构 */
export interface EntriesFile {
  entries: Entry[];
}

/** 空文件默认值 */
export function emptyEntriesFile(): EntriesFile {
  return { entries: [] };
}