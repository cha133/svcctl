// svcctl (Windows): 多 entry supervisor
// 职责：
//   1. 隐藏自身 console（#![windows_subsystem = "windows"]）
//   2. 写 ~/.svcctl/supervisor.pid
//   3. 读 ~/.svcctl/entries.toml（用 toml crate）
//   4. 对每条 startup:true 的 entry 用 CREATE_NO_WINDOW 拉起，
//      stdio 重定向到 ~/.svcctl/logs/<name>.log（append）
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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

use serde::{Deserialize, Serialize};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const REAP_INTERVAL_MS: u64 = 1000;
const RESTART_BACKOFF_MS: u64 = 1000;

// v0.4.4: Job Object 让 supervisor 真正成为进程树根 —— 关 Job handle 时整个 Job 内进程
// （含 cctra 的 grandchild）自动被 OS TerminateProcess
#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x00002000;

// v0.4.4: 温柔 stop 等待时长。systemd=90s / supervisord=10s / docker=10s 折中选 30s
// （给 DB 写盘 / HTTP 关连接 / 文件 sync 留时间）
const GRACE_PERIOD_MS: u64 = 30000;

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Entry {
    name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    #[serde(default = "default_true")]
    startup: bool,
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
    entry: Entry,
}

fn main() {
    if let Err(e) = run() {
        let _ = writeln!(std::io::stderr(), "[svcctl] fatal: {}", e);
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let svcctl_dir = locate_svcctl_dir()?;
    fs::create_dir_all(svcctl_dir.join("logs")).map_err(|e| e.to_string())?;
    let pid_path = svcctl_dir.join("supervisor.pid");
    let sup_log_path = svcctl_dir.join("supervisor.log");
    let entries_path = svcctl_dir.join("entries.toml");
    let children_json_path = svcctl_dir.join("children.json");

    let my_pid = std::process::id().to_string();
    fs::write(&pid_path, &my_pid).map_err(|e| e.to_string())?;
    log_line(&sup_log_path, &format!("supervisor started (pid={})", my_pid));

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
            if rec.child.is_none()
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

    // v0.4.4: 先删 control.json 再做事 —— kill_tree_windows 里 30s
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

    let mut cmd = Command::new(&entry.command);
    cmd.args(&entry.args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err))
        .creation_flags(CREATE_NO_WINDOW);
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

// v0.4.4: 温柔发 Ctrl+C 给指定 pid 的 console subsystem 进程。
// supervisor 是 windows subsystem（无 console）必须先 AttachConsole 到目标进程，
// 然后 SetConsoleCtrlHandler(None, TRUE) 屏蔽自己的 handler 避免自杀。
// 返回 true 表示成功 attach + generate。
#[cfg(windows)]
unsafe fn send_ctrl_c(pid: u32) -> bool {
    use windows_sys::Win32::System::Console::{
        AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, CTRL_C_EVENT,
    };
    let _ = FreeConsole();
    if AttachConsole(pid) == 0 {
        return false;
    }
    SetConsoleCtrlHandler(None, 1); // 1 = TRUE = 屏蔽自己的 handler
    let ok = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0;
    // 必须 sleep 一会儿再 FreeConsole / 恢复 handler，否则会自杀
    std::thread::sleep(std::time::Duration::from_millis(100));
    SetConsoleCtrlHandler(None, 0); // 0 = FALSE = 恢复
    let _ = FreeConsole();
    ok
}

/// v0.4.4: 温柔 + 兜底杀 entry 的整棵进程树。
/// 1) 温柔 Ctrl+C 触发 SIGINT handler（30s 等待 child 自己退）
/// 2) 兜底关 Job handle → OS 杀整个 Job 内所有进程（含 grandchild）
/// 3) child.wait() reap 自己的 handle
#[cfg(windows)]
fn kill_tree_windows(rec: &mut ChildRecord, sup_log_path: &PathBuf) {
    let pid = rec.child.as_ref().and_then(|c| Some(c.id()));

    // 1) 温柔 Ctrl+C（仅当 child 还活着）
    let sent_ctrlc = pid.map(|p| unsafe { send_ctrl_c(p) }).unwrap_or(false);
    if sent_ctrlc {
        log_line(sup_log_path, &format!("sent Ctrl+C to pid={:?}", pid));
    }

    // 2) 等 30s 看 child 自然退（轮询 try_wait，提早收工）
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
                let mut rec = ChildRecord {
                    child: None,
                    #[cfg(windows)]
                    job_handle: None,
                    last_spawn: Instant::now(),
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
                } else if was_startup && !is_startup && !manual.contains(&entry.name) {
                    // startup true→false：kill（除非被手动 start 过）
                    kill_tree_windows(rec, sup_log_path);
                    rec.last_spawn = Instant::now();
                    rec.entry = entry.clone();
                    log_line(
                        sup_log_path,
                        &format!("startup disabled, stopping '{}'", entry.name),
                    );
                } else if !was_startup && is_startup && !paused.contains(&entry.name) {
                    // startup false→true：spawn（除非被手动 stop 过）
                    rec.entry = entry.clone();
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
    if a.command != b.command || a.args != b.args || a.cwd != b.cwd {
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

fn locate_svcctl_dir() -> Result<PathBuf, String> {
    if let Ok(p) = env::var("SVCCTL_HOME") {
        let path = PathBuf::from(p);
        if path.exists() {
            return Ok(path);
        }
    }
    let home = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .map_err(|_| "USERPROFILE / HOME not set".to_string())?;
    Ok(PathBuf::from(home).join(".svcctl"))
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
    // 简化时间戳：unix ms（避免引 chrono 多一个 crate）
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = format!("[{}] [INFO] {}\n", ts, msg);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
    let _ = std::io::stderr().write_all(line.as_bytes());
}
