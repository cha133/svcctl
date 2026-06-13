/**
 * 校验 entry.command 字段是否像用户期望的单 token 可执行文件
 *
 * 背景：commander 把每个 shell token 视作独立参数（不像 docker/npm 那样再 split）。
 * 用户经常误用 `svcctl add "cctra serve"`，以为引号会按 shell 拆词，
 * 结果 command 字段变成字面字符串 "cctra serve"，supervisor spawn 时
 * "program not found"。
 *
 * 判定规则：
 *   - command 含空格 AND 不含路径分隔符（/ 或 \）→ 视为引号错误
 *   - command 含路径分隔符（含或不含空格）→ 合法（Windows / Unix / macOS 路径）
 *   - 其它情况 → 合法
 *
 * 误伤的合法 case（白名单）：
 *   - "C:\Program Files\My App\app.exe"      → 有 \ → 放行
 *   - "/Applications/My App.app/..."         → 有 / → 放行
 *   - "/usr/local/bin/foo bar.sh"（少见但有）→ 有 / → 放行
 */
export function looksLikeShellTokenizationMistake(command: string): boolean {
  return command.includes(" ") && !/[/\\]/.test(command);
}
