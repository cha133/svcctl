import pc from "picocolors";

/** 成功提示（绿勾 + 文案） */
export function success(msg: string): void {
  console.log(pc.green("✓ ") + msg);
}

/** 信息提示（蓝 i + 文案） */
export function info(msg: string): void {
  console.log(pc.cyan("ℹ ") + msg);
}

/** 错误提示（红 ✗ + 文案，写到 stderr） */
export function error(msg: string): void {
  console.error(pc.red("✗ ") + msg);
}

/** 警告提示（黄 ! + 文案） */
export function warn(msg: string): void {
  console.log(pc.yellow("! ") + msg);
}

/** 灰显（弱化文字） */
export function dim(msg: string): string {
  return pc.dim(msg);
}

/** 绿（用于 status 列等） */
export function green(msg: string): string {
  return pc.green(msg);
}

/** 红 */
export function red(msg: string): string {
  return pc.red(msg);
}

/** 黄 */
export function yellow(msg: string): string {
  return pc.yellow(msg);
}

/** 加粗 */
export function bold(msg: string): string {
  return pc.bold(msg);
}

/** 简单 k/v 排版：14 字符 key 列对齐 —— 给 status [name] 用 */
export function kvRow(k: string, v: string): string {
  return `${k.padEnd(14)}${v}`;
}

// ---------------------------------------------------------------------------
// 本地时区时间格式化 —— 对标 systemd `journalctl` 设计：存储用 UTC（entries.toml
// createdAt / supervisor.log 行都是 ISO 8601 UTC），显示转本机时区。
//
// 注：Intl.DateTimeFormat 在构造时 freeze 时区。`bun test` 自身会把 TZ 设成 UTC
// 保证测试确定性，所以 formatter 必须**在每次调用时读 process.env.TZ**才让测试
// 设的 TZ 生效。构造开销几微秒，对 CLI 表格输出可忽略。
// ---------------------------------------------------------------------------

function makeFmt(withSec: boolean): Intl.DateTimeFormat {
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSec ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  };
  // process.env.TZ 优先级最高（用户/SCCtl 启动 env 显式指定）；非法 TZ 兜底系统默认
  const tz = process.env.TZ;
  if (tz) {
    try {
      return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz });
    } catch {
      // 非法 TZ 字符串（如 "Asia/Shanghi" 拼错）→ 忽略，用系统默认
    }
  }
  return new Intl.DateTimeFormat(undefined, opts);
}

/** 转成本机时区，格式 "2026-06-27 00:30"（16 字符）—— ls/log 列用 */
export function formatLocalTime(d: Date | number | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return formatDateToLocal(date, false);
}

/** 同上但带秒："2026-06-27 00:30:15"（19 字符）—— supervisor.log 行用 */
export function formatLocalTimeWithSec(d: Date | number | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return formatDateToLocal(date, true);
}

/**
 * 把 supervisor.log 的 `[<ISO>] [LEVEL] <msg>` 行前缀 ISO 时间戳改成本地时间。
 * 匹配失败或解析失败时原样返回（不抛错）。
 */
export function reformatSupervisorLogLine(line: string): string {
  const m = /^\[([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+\-Z]+)\] /.exec(line);
  if (!m) return line;
  const iso = m[1]!;
  const local = formatLocalTimeWithSec(iso);
  return line.replace(`[${iso}]`, `[${local}]`);
}

function formatDateToLocal(d: Date, withSec: boolean): string {
  const fmt = makeFmt(withSec);
  const parts = fmt.formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? "00";
  // 部分 locale 会把午夜渲成 hour="24"，兜底成 "00"
  const h = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${h}:${get("minute")}${
    withSec ? ":" + get("second") : ""
  }`;
}
