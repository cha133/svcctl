// svcctl (Windows): 多 entry supervisor
// 职责：
//   1. 隐藏自身 console（#![windows_subsystem = "windows"]）
//   2. 写 supervisor.pid / supervisor.log / children.json 到 state_dir
//      （v0.5.5：全平台 hardcode homedir()，state_dir = homedir()/.local/state/svcctl，
//       entries = homedir()/.config/svcctl/entries.toml，见 locate_svcctl_paths）
//   3. 读 entries.toml
//   4. 对每条 startup:true 的 entry 用 CREATE_NO_WINDOW 拉起，
//      stdio 重定向到 state_dir/logs/<name>.log（append）
//      startup:false 的 entry 只记录不 spawn（等 manual start）
//   5. 主循环：
//      - process_control_file() 处理 CLI 通过 control.json 发来的命令
//      - mtime 检查 entries.toml，变了就 reconcile（合并到 reap loop）
//      - try_wait 死掉的子进程，按 backoff 重启（跳过 paused 的）
//   6. ctrl-c handler：杀 child + 删 pid + exit

#![windows_subsystem = "windows"]

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::{Duration, Instant, UNIX_EPOCH};

use chrono::{SecondsFormat, Utc};

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

use serde::{Deserialize, Serialize};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
// v0.4.15: child 是新 process group leader（pgid = child pid），
// 让 send_ctrl_break 能 targeted 投递（GenerateConsoleCtrlEvent CTRL_BREAK_EVENT, pgid），
// 不再依赖 supervisor (windows subsystem) 第一次 AttachConsole 的 broadcast 路径
// （那条路径前几次 send 必 fail，console membership 注册有 race）。
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const REAP_INTERVAL_MS: u64 = 1000;
const RESTART_BACKOFF_MS: u64 = 1000;

// v0.4.4: Job Object 让 supervisor 真正成为进程树根 —— 关 Job handle 时整个 Job 内进程
// （含 cctra 的 grandchild）自动被 OS TerminateProcess
#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x00002000;

// v0.4.4: 温柔 stop 等待时长。systemd=90s / supervisord=10s / docker=10s 折中
// v0.4.9: 30s → 5s。30s 对 simple dev tools 严重过度；Job Object 兜底强杀 100% 杀得动
// 5s 还没退就视为不响应 SIGINT（如 cctra case），走 Job close。要改直接改 const
const GRACE_PERIOD_MS: u64 = 5000;

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Entry {
    name: String,
    command: String,
    /// v0.5.7: add 时解析好的绝对路径（可选）。存在且文件仍在 → 直接用；
    /// 否则回退到运行时 resolve_command（存量 entry 无此字段也兼容）。
    #[serde(default)]
    resolved: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default = "default_true")]
    startup: bool,
    /// v0.4.7: 死了是否 opt-in 自动重启。默认 false —— 大部分程序内部都有全局 catch 不容易死，
    /// 不需要 supervisor 兜底；想要兜底就在 entries.toml 加 `restart = true`。
    #[serde(default)]
    restart: bool,
}

fn default_true() -> bool { true }

#[derive(Debug, Deserialize)]
struct ControlCommand {
    action: String,
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    ts: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct EntriesFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    entries: Vec<Entry>,
}

fn default_version() -> u32 { 1 }

struct ChildRecord {
    child: Option<std::process::Child>,
    /// v0.4.4: Windows Job handle —— 持有它不让 Job 关闭，OS 就不会回收 Job 成员进程。
    /// 在 Phase B 的 `kill_tree_windows` 里调 CloseHandle 触发 OS 杀整棵树。
    /// 字段值是 raw HANDLE（*mut c_void），不实现 Drop 自动关 —— 我们要 explicit 控制。
    #[cfg(windows)]
    job_handle: Option<*mut c_void>,
    last_spawn: Instant,
    /// v0.4.7: 是否"期望运行"（reconcile 决定的意图）
    /// 区分 reconcile 故意没 spawn 的 entry（want_run=false, reap 块不要重启）
    /// 和 spawn 后死了的 entry（want_run=true, reap 块按 restart 策略重启）。
    want_run: bool,
    entry: Entry,
}

fn main() {
    if let Err(e) = run() {
        let _ = writeln!(std::io::stderr(), "[svcctl] fatal: {}", e);
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let paths = locate_svcctl_paths()?;
    let svcctl_dir = paths.state_dir.clone();
    fs::create_dir_all(svcctl_dir.join("logs")).map_err(|e| e.to_string())?;
    let pid_path = svcctl_dir.join("supervisor.pid");
    let sup_log_path = svcctl_dir.join("supervisor.log");
    let entries_path = paths.entries;
    let children_json_path = svcctl_dir.join("children.json");

    let my_pid = std::process::id().to_string();
    fs::write(&pid_path, &my_pid).map_err(|e| e.to_string())?;
    log_line(&sup_log_path, &format!("supervisor started (pid={})", my_pid));

    // v0.5.7: 删掉上一任 supervisor 残留的 control.json。
    // 场景：CLI `svcctl stop`（无参）先给每个 entry 写 stop 命令到 control.json，
    // 然后立刻 taskkill /F —— supervisor 每 1s 才轮询一次，大概率没读到就被杀，
    // control.json 残留。新 supervisor 若不清理，会在启动后执行这条"幽灵 stop"，
    // 把刚 spawn 的 entry 又杀掉（实测：stop+start 后 dsh-web 起不来）。
    let stale_control = svcctl_dir.join("control.json");
    if stale_control.exists() {
        let _ = fs::remove_file(&stale_control);
        log_line(&sup_log_path, "removed stale control.json from previous supervisor lifetime");
    }

    // ctrl-c handler
    let (tx, rx) = channel::<()>();
    ctrlc::set_handler(move || {
        let _ = tx.send(());
    }).map_err(|e| e.to_string())?;

    let mut state: HashMap<String, ChildRecord> = HashMap::new();
    let mut paused: HashSet<String> = HashSet::new();
    let mut manual: HashSet<String> = HashSet::new();

    // 初次 load
    if let Err(e) = reconcile(
        &entries_path, &svcctl_dir, &sup_log_path,
        &children_json_path, &mut state, &mut paused, &mut manual,
    ) {
        log_line(&sup_log_path, &format!("initial reconcile failed: {}", e));
    }
    let mut last_mtime: u64 = file_mtime_ms(&entries_path);

    let poll = Duration::from_millis(REAP_INTERVAL_MS);
    let mut last_children_write: Instant = Instant::now();

    loop {
        match rx.recv_timeout(poll) {
            Ok(()) => {
                log_line(&sup_log_path, "received ctrl-c, shutting down");
                break;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        // 处理 CLI 通过 control.json 发来的命令
        process_control_file(
            &svcctl_dir, &sup_log_path, &entries_path,
            &children_json_path, &mut state, &mut paused, &mut manual,
        );

        // mtime 检查（合并到 reap loop，零额外开销）
        let mtime = file_mtime_ms(&entries_path);
        if mtime > 0 && mtime != last_mtime {
            log_line(&sup_log_path, "entries.toml changed, reconciling");
            if let Err(e) = reconcile(
                &entries_path, &svcctl_dir, &sup_log_path,
                &children_json_path, &mut state, &mut paused, &mut manual,
            ) {
                log_line(&sup_log_path, &format!("reconcile failed: {}", e));
            }
            last_mtime = mtime;
        }

        // reap 死掉的子进程 + 重启（跳过手动 stop 的）
        let now = Instant::now();
        for (name, rec) in state.iter_mut() {
            if let Some(child) = rec.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        log_line(
                            &sup_log_path,
                            &format!("child '{}' exited (status: {:?})", name, status),
                        );
                        rec.child = None;
                        rec.last_spawn = now;
                    }
                    Ok(None) => continue,
                    Err(e) => {
                        log_line(
                            &sup_log_path,
                            &format!("try_wait error for '{}': {}", name, e),
                        );
                        rec.child = None;
                        rec.last_spawn = now;
                    }
                }
            }
            if rec.want_run                                                // v0.4.7: 区分 reconcile 故意没 spawn
                && rec.entry.restart                                        // v0.4.7: opt-in 才重启
                && rec.child.is_none()
                && now.duration_since(rec.last_spawn).as_millis() as u64 >= RESTART_BACKOFF_MS
                && !paused.contains(name)
            {
                let entry = rec.entry.clone();
                if let Err(e) = spawn_one(&entry, &svcctl_dir, rec, &sup_log_path) {
                    log_line(
                        &sup_log_path,
                        &format!("respawn '{}' failed: {}", name, e),
                    );
                } else {
                    let pid = rec.child.as_ref().map(|c| c.id());
                    log_line(&sup_log_path, &format!("respawned '{}' (pid={:?})", name, pid));
                }
            }
        }

        // 周期写 children.json（1s 一次）
        if now.duration_since(last_children_write).as_millis() as u64 >= 1000 {
            write_children_json(&children_json_path, &state);
            last_children_write = now;
        }
    }

    // shutdown
    for (name, mut rec) in state.drain() {
        kill_tree_windows(&mut rec, &sup_log_path);
        log_line(&sup_log_path, &format!("killed child '{}'", name));
    }
    let _ = fs::remove_file(&pid_path);
    let _ = fs::remove_file(&children_json_path);
    Ok(())
}

fn process_control_file(
    svcctl_dir: &PathBuf,
    sup_log_path: &PathBuf,
    entries_path: &PathBuf,
    children_json_path: &PathBuf,
    state: &mut HashMap<String, ChildRecord>,
    paused: &mut HashSet<String>,
    manual: &mut HashSet<String>,
) {
    let control_path = svcctl_dir.join("control.json");
    if !control_path.exists() {
        return;
    }

    let raw = match fs::read_to_string(&control_path) {
        Ok(s) => s,
        Err(_) => {
            let _ = fs::remove_file(&control_path);
            return;
        }
    };

    let cmd: ControlCommand = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(_) => {
            log_line(sup_log_path, "control: invalid JSON, removing");
            let _ = fs::remove_file(&control_path);
            return;
        }
    };

    // v0.5.9: 全局温柔停机（CLI `svcctl stop` 无参走这里）。必须在 entry lookup
    // 之前处理——shutdown 不携带 entry name。
    // 跟 ctrl-c 退出路径同一套语义：逐 child kill_tree_windows（定向 Ctrl+Break
    // + 5s grace + Job 兑底），全杀完删 pid/children.json 再退出。
    // 取代旧路径（CLI 给每个 entry 写 stop 再立刻 taskkill /F）：control.json
    // 单文件互相覆盖只剩最后一条、grace 来不及生效、还残留幽灵 control.json。
    if cmd.action == "shutdown" {
        let _ = fs::remove_file(&control_path);
        log_line(sup_log_path, "received shutdown command, stopping all children");
        for (name, mut rec) in state.drain() {
            kill_tree_windows(&mut rec, sup_log_path);
            log_line(sup_log_path, &format!("killed child '{}'", name));
        }
        let _ = fs::remove_file(svcctl_dir.join("supervisor.pid"));
        let _ = fs::remove_file(children_json_path);
        std::process::exit(0);
    }

    // 读 entries.toml 拿该 entry 的最新 config
    let entry = match (|| -> Result<Option<Entry>, String> {
        let bytes = fs::read(entries_path).map_err(|e| e.to_string())?;
        let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        let parsed: EntriesFile = toml::from_str(&text).map_err(|e| e.to_string())?;
        Ok(parsed.entries.into_iter().find(|e| e.name == cmd.name))
    })() {
        Ok(Some(e)) => e,
        Ok(None) => {
            log_line(sup_log_path, &format!("control: entry '{}' not found", cmd.name));
            let _ = fs::remove_file(&control_path);
            return;
        }
        Err(e) => {
            log_line(sup_log_path, &format!("control: load entries failed: {}", e));
            let _ = fs::remove_file(&control_path);
            return;
        }
    };

    // v0.4.4: 先删 control.json 再做事 —— kill_tree_windows 里 5s（v0.4.9）
    // grace 等待不能阻塞 CLI 的 waitForControlProcessed（5s timeout）。
    // 这符合 systemctl 语义：命令返回后 daemon 异步完成工作。
    let _ = fs::remove_file(&control_path);

    match cmd.action.as_str() {
        "start" => {
            manual.insert(cmd.name.clone());
            paused.remove(&cmd.name);
            match state.get(&cmd.name) {
                Some(rec) if rec.child.is_some() => {
                    log_line(sup_log_path, &format!("'{}' is already running", cmd.name));
                }
                _ => {
                    let mut rec = ChildRecord {
                        child: None,
                        #[cfg(windows)]
                        job_handle: None,
                        last_spawn: Instant::now(),
                        want_run: true, // v0.4.7: "start" 一定期望运行
                        entry: entry.clone(),
                    };
                    if let Err(e) = spawn_one(&entry, svcctl_dir, &mut rec, sup_log_path) {
                        log_line(sup_log_path, &format!("manual start '{}' failed: {}", cmd.name, e));
                    }
                    state.insert(cmd.name.clone(), rec);
                    write_children_json(children_json_path, state);
                }
            }
        }
        "stop" => {
            paused.insert(cmd.name.clone());
            manual.remove(&cmd.name);
            if let Some(rec) = state.get_mut(&cmd.name) {
                kill_tree_windows(rec, sup_log_path);
                log_line(sup_log_path, &format!("manually stopped '{}'", cmd.name));
                rec.last_spawn = Instant::now();
                rec.want_run = false; // v0.4.7: 手动 stop 后不期望再跑（与 paused 双重保险）
            } else {
                log_line(sup_log_path, &format!("'{}' is not running", cmd.name));
            }
            write_children_json(children_json_path, state);
        }
        "restart" => {
            manual.insert(cmd.name.clone());
            paused.remove(&cmd.name);
            if let Some(rec) = state.get_mut(&cmd.name) {
                kill_tree_windows(rec, sup_log_path);
                rec.last_spawn = Instant::now();
            }
            let mut rec = ChildRecord {
                child: None,
                #[cfg(windows)]
                job_handle: None,
                last_spawn: Instant::now(),
                want_run: true, // v0.4.7: "restart" 一定期望运行
                entry: entry.clone(),
            };
            if let Err(e) = spawn_one(&entry, svcctl_dir, &mut rec, sup_log_path) {
                log_line(sup_log_path, &format!("restart spawn '{}' failed: {}", cmd.name, e));
            }
            state.insert(cmd.name.clone(), rec);
            write_children_json(children_json_path, state);
            log_line(sup_log_path, &format!("restarted '{}'", cmd.name));
        }
        _ => {
            log_line(sup_log_path, &format!("control: unknown action '{}'", cmd.action));
        }
    }
}

/// v0.5.7: CreateProcessW 只自动补 .exe、**不查 PATHEXT**，npm/scoop 的 `.cmd` shim
/// （如 `dsh` → `dsh.cmd`）会 spawn "program not found"。手动按 PATH+PATHEXT 解析裸命令名：
///   - 含路径分隔符 → 原样返回（用户已显式给路径）
///   - 逐 PATH 目录按 PATHEXT 顺序尝试；跳过无扩展名文件（bash shim 执行不了）
///   - 解析不到 → 原样返回（保留 CreateProcess 自带搜索：system32 / CWD 等）
fn resolve_command(command: &str) -> String {
    if command.contains(['/', '\\']) {
        return command.to_string();
    }
    let path_var = env::var("PATH").unwrap_or_default();
    let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let exts: Vec<String> = pathext
        .split(';')
        .map(|e| e.trim().to_uppercase())
        .filter(|e| !e.is_empty())
        .collect();

    // 已带扩展名（如 "foo.exe"）：扩展必须在 PATHEXT 内，按原名找
    if let Some(dot) = command.rfind('.') {
        if dot > 0 {
            let ext = command[dot..].to_uppercase();
            if exts.iter().any(|e| e == &ext) {
                for dir in path_var.split(';').filter(|d| !d.is_empty()) {
                    let cand = PathBuf::from(dir).join(command);
                    if cand.is_file() {
                        return cand.to_string_lossy().into_owned();
                    }
                }
            }
            return command.to_string();
        }
    }

    // 裸名：目录优先，目录内按 PATHEXT 顺序（Windows FS 大小写不敏感）
    for dir in path_var.split(';').filter(|d| !d.is_empty()) {
        for ext in &exts {
            let cand = PathBuf::from(dir).join(format!("{}{}", command, ext.to_lowercase()));
            if cand.is_file() {
                return cand.to_string_lossy().into_owned();
            }
        }
    }
    command.to_string()
}

/// v0.5.7: .cmd/.bat 不能被 CreateProcessW 直接执行，需 cmd.exe 包装
fn is_batch_script(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// v0.5.7: cmd 命令行 token 引号处理。含空白 / cmd 元字符 / 引号时包双引号，
/// 内嵌引号用 \"（target 程序侧 CommandLineToArgvW 能解）。
fn quote_cmd_token(s: &str) -> String {
    if s.is_empty() || s.chars().any(|c| " \t&|<>^\"".contains(c)) {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

fn spawn_one(
    entry: &Entry,
    svcctl_dir: &PathBuf,
    rec: &mut ChildRecord,
    sup_log_path: &PathBuf,
) -> Result<(), String> {
    let log_path = svcctl_dir.join("logs").join(format!("{}.log", entry.name));
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("open log {}: {}", log_path.display(), e))?;
    let log_file_err = log_file.try_clone().map_err(|e| e.to_string())?;

    // v0.5.7: spawn 路径优先级 —— entry.resolved（add 时解析存好的，文件还在才用）
    // → 运行时 resolve_command（PATH+PATHEXT）。.cmd/.bat 走 cmd.exe /d /s /c 包装。
    // /s 语义：去掉 /c 后字符串的首尾引号，中间原样执行 → 避免 cmd 引号规则的坑。
    // 不弹黑框已实验验证：cmd.exe 带 CREATE_NO_WINDOW 时，批处理里的孙子进程
    // 也拿不到 console（GetConsoleWindow()=0）。
    let resolved = match &entry.resolved {
        Some(r) if !r.is_empty() && PathBuf::from(r).is_file() => r.clone(),
        _ => resolve_command(&entry.command),
    };
    let mut cmd = if is_batch_script(&resolved) {
        let mut line = quote_cmd_token(&resolved);
        for a in &entry.args {
            line.push(' ');
            line.push_str(&quote_cmd_token(a));
        }
        let comspec = env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = Command::new(comspec);
        // raw_arg：整行手工构造，避免 Rust 默认的 MSVCRT 引号规则跟 cmd 规则叠加
        c.raw_arg(format!("/d /s /c \"{}\"", line));
        if resolved != entry.command {
            log_line(
                sup_log_path,
                &format!("resolved '{}' → '{}' (via cmd /c)", entry.command, resolved),
            );
        }
        c
    } else {
        if resolved != entry.command {
            log_line(
                sup_log_path,
                &format!("resolved '{}' → '{}'", entry.command, resolved),
            );
        }
        let mut c = Command::new(&resolved);
        c.args(&entry.args);
        c
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err))
        .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    if let Some(cwd) = &entry.cwd {
        cmd.current_dir(cwd);
    }
    for (k, v) in &entry.env {
        cmd.env(k, v);
    }

    let child = cmd.spawn().map_err(|e| format!("spawn: {}", e))?;
    let pid = child.id();

    // v0.4.4: 把 child 加进 Job（KILL_ON_JOB_CLOSE）—— 任何时候关 Job handle 都会
    // 让 OS 杀整个 Job 内进程树（含 child 的 grandchild，无需 supervisor 跟踪）
    #[cfg(windows)]
    {
        let raw = child.as_raw_handle();
        let job = unsafe { create_kill_on_close_job() };
        match job {
            Some(job) => {
                let assigned = unsafe { assign_to_job(job, raw as *mut c_void) };
                if assigned {
                    rec.job_handle = Some(job);
                    log_line(
                        sup_log_path,
                        &format!("spawned '{}' (pid={}, in job)", entry.name, pid),
                    );
                } else {
                    log_line(
                        sup_log_path,
                        &format!("spawned '{}' (pid={}, FAILED to assign to job)", entry.name, pid),
                    );
                    unsafe { windows_sys::Win32::Foundation::CloseHandle(job); }
                }
            }
            None => {
                log_line(
                    sup_log_path,
                    &format!("spawned '{}' (pid={}, job create failed)", entry.name, pid),
                );
            }
        }
    }

    rec.child = Some(child);
    rec.last_spawn = Instant::now();
    rec.entry = entry.clone();
    Ok(())
}

// v0.4.4: Job Object helpers —— 让 supervisor 真正成为进程树根
#[cfg(windows)]
unsafe fn create_kill_on_close_job() -> Option<*mut c_void> {
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    use windows_sys::Win32::Foundation::CloseHandle;

    let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
    if job.is_null() {
        return None;
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &info as *const _ as *const _,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    );
    if ok == 0 {
        CloseHandle(job);
        return None;
    }
    Some(job)
}

#[cfg(windows)]
unsafe fn assign_to_job(job: *mut c_void, process_handle: *mut c_void) -> bool {
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    AssignProcessToJobObject(job, process_handle) != 0
}

// v0.4.15: 温柔发 ctrl+break 给指定 pid 的 console subsystem 进程（child 在新 process
// group 里，pgid = child pid）。**比 v0.4.4 的 CTRL_C_EVENT broadcast 可靠**：
// 老方案 supervisor 是 windows-subsystem（自身无 console），第一次 AttachConsole 到
// child 的 console 后 broadcast，console membership 注册有 race，前几次必 fail（A2
// 验证：probe 单层 bun 也 fail，跟 cctra 多层无关）。
// 新方案 GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pgid) 定向投递到 child 自己的
// process group，不依赖 broadcast 时 console membership 是否稳定。
// CTRL_BREAK 在 console 内是 always handled（不能被 SetConsoleCtrlHandler disable），
// bun runtime 翻译成 SIGBREAK（已在 cctra 端装 SIGBREAK handler 处理 graceful cleanup）。
// 仍需 AttachConsole 让 supervisor share child console（GenerateConsoleCtrlEvent 要求）。
#[cfg(windows)]
unsafe fn send_ctrl_break(pid: u32) -> bool {
    use windows_sys::Win32::System::Console::{
        AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler,
        CTRL_BREAK_EVENT,
    };
    let _ = FreeConsole();
    if AttachConsole(pid) == 0 {
        return false;
    }
    SetConsoleCtrlHandler(None, 1); // 1 = TRUE = 屏蔽自己的 handler 避免 supervisor 收到 break 自杀
    let ok = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) != 0; // pid = pgid（CREATE_NEW_PROCESS_GROUP）
    std::thread::sleep(std::time::Duration::from_millis(100));
    SetConsoleCtrlHandler(None, 0); // 0 = FALSE = 恢复
    let _ = FreeConsole();
    ok
}

/// v0.4.15: 温柔 ctrl+break + 兜底杀 entry 的整棵进程树。
/// 1) 温柔 CTRL_BREAK_EVENT 定向 child pgid 触发 SIGBREAK handler（5s 等待 child 自己退）
/// 2) 兜底关 Job handle → OS 杀整个 Job 内所有进程（含 grandchild）
/// 3) child.wait() reap 自己的 handle
#[cfg(windows)]
fn kill_tree_windows(rec: &mut ChildRecord, sup_log_path: &PathBuf) {
    let pid = rec.child.as_ref().and_then(|c| Some(c.id()));

    // 1) 温柔 CTRL_BREAK（仅当 child 还活着）
    let sent = pid.map(|p| unsafe { send_ctrl_break(p) }).unwrap_or(false);
    if sent {
        log_line(sup_log_path, &format!("sent Ctrl+Break to pid={:?}", pid));
    }

    // 2) 等 GRACE_PERIOD_MS 看 child 自然退（轮询 try_wait，提早收工）
    let start = std::time::Instant::now();
    if let Some(child) = rec.child.as_mut() {
        while start.elapsed() < std::time::Duration::from_millis(GRACE_PERIOD_MS) {
            if let Ok(Some(status)) = child.try_wait() {
                log_line(
                    sup_log_path,
                    &format!("child pid={:?} exited gracefully (status={:?})", pid, status),
                );
                rec.child = None;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    // 3) 兜底：关 Job handle → OS 杀整棵进程树
    if let Some(job) = rec.job_handle.take() {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
        log_line(
            sup_log_path,
            &format!("closed job for pid={:?} (force kill tree)", pid),
        );
    }

    // 4) reap 自己的 handle
    if let Some(mut child) = rec.child.take() {
        let _ = child.wait();
    }
}

fn reconcile(
    entries_path: &PathBuf,
    svcctl_dir: &PathBuf,
    sup_log_path: &PathBuf,
    children_json_path: &PathBuf,
    state: &mut HashMap<String, ChildRecord>,
    paused: &mut HashSet<String>,
    manual: &mut HashSet<String>,
) -> Result<(), String> {
    let bytes = fs::read(entries_path).map_err(|e| e.to_string())?;
    let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    let parsed: EntriesFile = toml::from_str(&text).map_err(|e| e.to_string())?;
    let new_names: HashSet<String> = parsed.entries.iter().map(|e| e.name.clone()).collect();

    // 1. 删 state 里没在 entries 里的（同时清理 paused/manual set）
    let to_remove: Vec<String> = state
        .keys()
        .filter(|n| !new_names.contains(*n))
        .cloned()
        .collect();
    for n in to_remove {
        if let Some(mut rec) = state.remove(&n) {
            kill_tree_windows(&mut rec, sup_log_path);
            log_line(sup_log_path, &format!("killed removed entry '{}'", n));
        }
        paused.remove(&n);
        manual.remove(&n);
    }

    // 2. spawn 新增的 / 处理变化的 entry
    for entry in parsed.entries {
        let should_run = entry.startup || manual.contains(&entry.name);

        match state.get_mut(&entry.name) {
            None => {
                // 新增 entry
                // v0.4.7: want_run 表达"是否期望运行"——manual entry 故意不 spawn 时
                // 也设为 false，reap 块就不会把 rec 当成"死了要重启"误启动。
                let mut rec = ChildRecord {
                    child: None,
                    #[cfg(windows)]
                    job_handle: None,
                    last_spawn: Instant::now(),
                    want_run: should_run && !paused.contains(&entry.name),
                    entry: entry.clone(),
                };
                if should_run && !paused.contains(&entry.name) {
                    if let Err(e) = spawn_one(&entry, svcctl_dir, &mut rec, sup_log_path) {
                        log_line(
                            sup_log_path,
                            &format!("initial spawn '{}' failed: {}", entry.name, e),
                        );
                    }
                }
                state.insert(entry.name.clone(), rec);
            }
            Some(rec) => {
                // 已存在的 entry
                let was_startup = rec.entry.startup;
                let is_startup = entry.startup;
                let changed = entry_changed(&rec.entry, &entry);

                if changed {
                    // command/args/cwd/env 变了 → 重启
                    kill_tree_windows(rec, sup_log_path);
                    rec.last_spawn = Instant::now();
                    rec.entry = entry.clone();

                    if should_run && !paused.contains(&entry.name) {
                        let entry_clone = entry.clone();
                        if let Err(e) = spawn_one(&entry_clone, svcctl_dir, rec, sup_log_path) {
                            log_line(
                                sup_log_path,
                                &format!("respawn '{}' failed: {}", entry.name, e),
                            );
                        }
                    }
                    // v0.4.7: 表达意图（跟 None 分支语义对齐）
                    rec.want_run = should_run && !paused.contains(&entry.name);
                } else if was_startup && !is_startup && !manual.contains(&entry.name) {
                    // startup true→false：kill（除非被手动 start 过）
                    kill_tree_windows(rec, sup_log_path);
                    rec.last_spawn = Instant::now();
                    rec.entry = entry.clone();
                    rec.want_run = false; // v0.4.7: kill 后不期望再跑
                    log_line(
                        sup_log_path,
                        &format!("startup disabled, stopping '{}'", entry.name),
                    );
                } else if !was_startup && is_startup && !paused.contains(&entry.name) {
                    // startup false→true：spawn（除非被手动 stop 过）
                    rec.entry = entry.clone();
                    rec.want_run = true; // v0.4.7: 显式标记期望运行
                    let entry_clone = entry.clone();
                    if let Err(e) = spawn_one(&entry_clone, svcctl_dir, rec, sup_log_path) {
                        log_line(
                            sup_log_path,
                            &format!("startup enabled spawn '{}' failed: {}", entry.name, e),
                        );
                    } else {
                        log_line(
                            sup_log_path,
                            &format!("startup enabled, spawned '{}'", entry.name),
                        );
                    }
                } else {
                    // 没变化，更新 entry 引用
                    rec.entry = entry.clone();
                }
            }
        }
    }

    write_children_json(children_json_path, state);
    Ok(())
}

fn entry_changed(a: &Entry, b: &Entry) -> bool {
    if a.command != b.command || a.resolved != b.resolved || a.args != b.args || a.cwd != b.cwd {
        return true;
    }
    a.env.len() != b.env.len() || a.env.iter().any(|(k, v)| b.env.get(k) != Some(v))
}

fn write_children_json(path: &PathBuf, state: &HashMap<String, ChildRecord>) {
    let mut data: HashMap<String, u32> = HashMap::new();
    for (name, rec) in state {
        if let Some(c) = &rec.child {
            data.insert(name.clone(), c.id());
        }
    }
    if let Ok(json) = serde_json::to_string_pretty(&data) {
        let _ = fs::write(path, json);
    }
}

/// v0.5.5: 全平台 hardcode `homedir()/.local/state/svcctl` 和 `homedir()/.config/svcctl/entries.toml`。
/// 不读 SVCCTL_HOME / XDG_*_HOME env，不 fallback 到 ~/.svcctl/。
/// 跟 JS 端 xdgStateHome() / xdgConfigHome() 硬编码值完全一致，避免跨进程路径错位。
struct SvcCtlPaths {
    /// supervisor 自身状态目录：supervisor.pid / supervisor.log / children.json / control.json
    state_dir: PathBuf,
    /// entries.toml 完整路径
    entries: PathBuf,
}

fn locate_svcctl_paths() -> Result<SvcCtlPaths, String> {
    #[cfg(windows)]
    let home = env::var("USERPROFILE").map_err(|_| "USERPROFILE not set".to_string())?;
    #[cfg(not(windows))]
    let home = env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let home_path = PathBuf::from(&home);
    Ok(SvcCtlPaths {
        state_dir: home_path.join(".local").join("state").join("svcctl"),
        entries: home_path.join(".config").join("svcctl").join("entries.toml"),
    })
}

fn file_mtime_ms(path: &PathBuf) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn log_line(path: &PathBuf, msg: &str) {
    // v0.4.6: ISO 8601 时间戳（`2026-06-14T12:54:01.706Z`），跟 JS `toISOString()` 一致
    // → `svcctl status` 在三平台输出格式统一
    let ts = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let line = format!("[{}] [INFO] {}\n", ts, msg);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
    let _ = std::io::stderr().write_all(line.as_bytes());
}
