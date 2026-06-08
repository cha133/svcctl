/**
 * svcctl CLI 入口 —— commander 派发
 */
import { program } from "commander";
import { register as registerAdd } from "./commands/add";
import { register as registerRemove } from "./commands/remove";
import { register as registerLs } from "./commands/ls";
import { register as registerLog } from "./commands/log";
import { register as registerStart } from "./commands/start";
import { register as registerStop } from "./commands/stop";
import { register as registerStatus } from "./commands/status";
import { register as registerInstall } from "./commands/install";
import { runSupervisor } from "./supervise";
import { error } from "./format";
import pkg from "../package.json" with { type: "json" };

program
  .name("svcctl")
  .version(pkg.version, "-v, --version")
  .description("cross-platform startup supervisor (register any command as a user-level autostart item)")
  .showHelpAfterError();

registerAdd(program);
registerRemove(program);
registerLs(program);
registerLog(program);
registerStart(program);
registerStop(program);
registerStatus(program);
registerInstall(program);

// 隐藏子命令：被 launchd / systemd / HKCU\Run 触发
program
  .command("_supervise", { hidden: true })
  .description("internal: supervisor entry point (called by OS auto-start)")
  .action(async () => {
    await runSupervisor();
  });

program.parseAsync().catch((e: unknown) => {
  error((e as Error).message);
  process.exit(1);
});
