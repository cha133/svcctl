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

/** 灰显原始输出（log 转发时用） */
export function dimRaw(msg: string): string {
  return pc.gray(msg);
}
