/**
 * Aggressive slugify: every non-alphanumeric run becomes a single "-".
 * Trims leading/trailing "-". No length cap.
 *
 * Examples:
 *   "bunx cctra"         -> "bunx-cctra"
 *   "bun", "run", "foo.js"  -> "bun-run-foo-js"
 *   "APIKEY.FUN"         -> "apikey-fun"
 *   "火山 Agentplan"     -> "-agentplan"  (then trimmed to "agentplan")
 *   "中文 命令"          -> "-"
 *   "foo  bar"           -> "foo-bar"
 *   "///foo///"          -> "foo"
 *   "-foo-"              -> "foo"
 */
export function slugify(command: string, ...args: string[]): string {
  return [command, ...args]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // 任何非字母数字 run → 单个 "-"
    .replace(/^-+|-+$/g, ""); // 去首尾 "-"
}

/** 校验 slug 合法（用于显式 --name） */
export function validateSlug(s: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);
}
