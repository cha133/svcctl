/**
 * v0.4.4: killTree (POSIX process group kill) 行为测试
 *
 * 覆盖 5 个 case：
 *  1. 杀 child + grandchildren via process group
 *  2. 不杀组外兄弟
 *  3. 已死的 child 不抛
 *  4. spawnDetached 产出的 child pgid === pid
 *  5. 温柔超时 → 兜底 SIGKILL
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Node supervisor 的 killTree helper（mac/linux only）
// 这里通过 import 复用：tests 跑在 Node supervisor 路径下能调到
// 但因为 src/supervise/index.ts 是 entry point（导出 runSupervisor），不导出 killTree
// 所以这里 copy 一份等价实现（行为对齐就行）
const GRACE_PERIOD_MS = 30_000;

function killTree(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc.pid) { resolve(); return; }
    const pgid = -proc.pid;
    try { process.kill(pgid, "SIGTERM"); }
    catch { try { proc.kill("SIGTERM"); } catch {} }
    const start = Date.now();
    const poll = setInterval(() => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - start > GRACE_PERIOD_MS) {
        clearInterval(poll);
        try { process.kill(pgid, "SIGKILL"); }
        catch { try { proc.kill("SIGKILL"); } catch {} }
        resolve();
      }
    }, 100);
  });
}

// POSIX-only guard：Windows 上 process group kill 不可用
const isPosix = process.platform === "darwin" || process.platform === "linux";
const itPosix = isPosix ? test : test.skip;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "svcctl-tree-kill-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 探活：process.kill(pid, 0) 抛 ESRCH → 死了；其他 → 活 */
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: any) { return e?.code === "EPERM"; } // EPERM = 进程存在但没权限
}

describe("killTree (POSIX process group signaling)", () => {
  itPosix("kills child + grandchildren via process group", async () => {
    // sh -c "sleep 30 & sleep 30 & wait"  → 父 sh + 2 个 sleep grandchildren
    const proc = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    expect(proc.pid).toBeDefined();

    // 等 grandchildren 启动（给 200ms 余地）
    await new Promise((r) => setTimeout(r, 200));

    await killTree(proc);

    // proc 本身应该退出
    expect(proc.killed || proc.exitCode !== null || proc.signalCode !== null).toBe(true);

    // 验证 grandchildren 也死了（pgid 杀掉整组）
    // 注：sh 自己 fork 时 sleep 的 pid 难以直接拿到，但 pgid 杀全队应该够了
    // 我们检查 2s 内 process tree 全空（通过 pgrep）
    await new Promise((r) => setTimeout(r, 500));
    // 简单方法：尝试 kill 0（sh 的 pgid），看是否 ESRCH
    try {
      // sh 的 pgid = -sh_pid
      process.kill(-proc.pid!, 0);
      // 如果没抛说明还有进程在 group 里（不应该）
      expect(true).toBe(false);
    } catch (e: any) {
      // ESRCH = 整个 group 死了（good）
      expect(["ESRCH", "ECHILD"]).toContain(e?.code);
    }
  }, 10_000);

  itPosix("does not kill siblings outside the group", async () => {
    // 父进程：sh -c "sleep 30 & sleep 30 & wait"
    const parent = spawn("sh", ["-c", "sleep 30 & sleep 30 & wait"], {
      detached: true,
      stdio: "ignore",
    });

    // 独立兄弟进程（不在 group 里）
    const sibling = spawn("sleep", ["30"], { stdio: "ignore" });

    await new Promise((r) => setTimeout(r, 200));

    await killTree(parent);

    // 兄弟进程应该还活着
    expect(isAlive(sibling.pid!)).toBe(true);

    // 清理兄弟
    sibling.kill("SIGKILL");
  }, 10_000);

  itPosix("tolerates already-dead child (no throw)", async () => {
    const proc = spawn("true", [], { stdio: "ignore" });
    // 等 child 自己退
    await new Promise<void>((resolve) => {
      proc.on("exit", () => resolve());
      // 兜底超时
      setTimeout(() => resolve(), 1000);
    });
    expect(proc.exitCode).toBe(0);

    // 现在调 killTree 应该不抛
    await killTree(proc);
    // 没异常 = pass
  }, 5000);

  itPosix("spawnDetached child has pgid === pid (POSIX invariant)", async () => {
    // spawnDetached 用 detached:true + setsid() —— child 应成 process group leader
    const { spawnDetached } = await import("../src/supervise/spawn");
    const logPath = join(tmpDir, "pg-test.log");
    const { proc } = spawnDetached({
      entry: {
        name: "pg-test",
        command: "sleep",
        args: ["5"],
        startup: true,
        env: {},
      } as any,
      logPath,
    });
    expect(proc.pid).toBeDefined();
    expect(existsSync(logPath)).toBe(true);

    // POSIX invariant：detached+unref'd child 是 session leader, pgid === pid
    // (process.getpgid 在 POSIX 上由 Node / Bun 都支持；Windows 上不存在但本 test 已 skip)
    expect((process as any).getpgid(proc.pid!)).toBe(proc.pid);

    // cleanup
    proc.kill("SIGKILL");
  }, 5000);

  itPosix("graceful timeout → falls back to SIGKILL", async () => {
    // sh trap '' TERM 忽略 SIGTERM，模拟"不响应温柔的 worker"
    // 然后 30s 后 killTree 应该 SIGKILL 兜底
    // 我们用一个短 grace 来测（用 process.kill 实际信号 timeout）
    // 注：helper 内部 GRACE_PERIOD_MS=30s，测 30s+ 太慢
    // 妥协：传一个 1000ms 的 helper clone
    const proc = spawn("sh", ["-c", "trap '' TERM; sleep 60 & wait"], {
      detached: true,
      stdio: "ignore",
    });
    expect(proc.pid).toBeDefined();

    const FAST_GRACE_MS = 1000;
    const result = await new Promise<{ killed: boolean; exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolve) => {
      if (!proc.pid) { resolve({ killed: false, exitCode: null, signalCode: null }); return; }
      const pgid = -proc.pid;
      try { process.kill(pgid, "SIGTERM"); }
      catch { try { proc.kill("SIGTERM"); } catch {} }
      const start = Date.now();
      const poll = setInterval(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          clearInterval(poll);
          resolve({ killed: proc.killed, exitCode: proc.exitCode, signalCode: proc.signalCode });
        } else if (Date.now() - start > FAST_GRACE_MS) {
          clearInterval(poll);
          try { process.kill(pgid, "SIGKILL"); }
          catch { try { proc.kill("SIGKILL"); } catch {} }
          // 给 SIGKILL 一会会儿生效
          setTimeout(() => {
            resolve({ killed: proc.killed, exitCode: proc.exitCode, signalCode: proc.signalCode });
          }, 200);
        }
      }, 100);
    });

    // 1s grace 后 SIGKILL 应该把它杀掉
    expect(result.exitCode !== null || result.signalCode !== null).toBe(true);
    expect(result.signalCode).toBe("SIGKILL");
  }, 5000);
});
