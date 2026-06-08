import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { supervisorLogPath } from "./paths";

/** 简单 logger：写到 ~/.svcctl/supervisor.log，带时间戳 */
export const logger = {
  info(msg: string): void {
    log("INFO", msg);
  },
  warn(msg: string): void {
    log("WARN", msg);
  },
  error(msg: string): void {
    log("ERROR", msg);
  },
  debug(msg: string): void {
    if (process.env.SVCCTL_DEBUG) log("DEBUG", msg);
  },
};

function log(level: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  const path = supervisorLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line, "utf-8");
  } catch {
    // 写日志失败不能影响主流程
  }
  // 同时输出到 stderr（supervisor 模式下 stdout 被吞，stderr 总是可见）
  process.stderr.write(line);
}
