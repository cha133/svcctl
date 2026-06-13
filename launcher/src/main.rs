// svcctl (Windows): 多 entry supervisor
// 职责：
//   1. 隐藏自身 console（#![windows_subsystem = "windows"]）
//   2. 写 ~/.svcctl/supervisor.pid
//   3. 读 ~/.svcctl/entries.toml（用 toml crate）
//   4. 对每条 entry 用 CREATE_NO_WINDOW 拉起，
//      stdio 重定向到 ~/.svcctl/logs/<name>.log（append）
//   5. 主循环：
//      - try_wait 死掉的子进程，按 backoff 重启
//      - mtime 检查 entries.toml，变了就 reconcile（合并到 reap loop，零额外开销）
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

use serde::{Deserialize, Serialize};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const REAP_INTERVAL_MS: u64 = 1000;
const RESTART_BACKOFF_MS: u64 = 1000;

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

    // 初次 load
    if let Err(e) = reconcile(&entries_path, &svcctl_dir, &sup_log_path, &children_json_path, &mut state) {
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

        // mtime 检查（合并到 reap loop，零额外开销）
        let mtime = file_mtime_ms(&entries_path);
        if mtime > 0 && mtime != last_mtime {
            log_line(&sup_log_path, "entries.toml changed, reconciling");
            if let Err(e) = reconcile(&entries_path, &svcctl_dir, &sup_log_path, &children_json_path, &mut state) {
                log_line(&sup_log_path, &format!("reconcile failed: {}", e));
            }
            last_mtime = mtime;
        }

        // reap 死掉的子进程 + 重启
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
            if rec.child.is_none() && now.duration_since(rec.last_spawn).as_millis() as u64 >= RESTART_BACKOFF_MS {
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
        if let Some(child) = rec.child.as_mut() {
            let _ = child.kill();
            log_line(&sup_log_path, &format!("killed child '{}'", name));
        }
    }
    let _ = fs::remove_file(&pid_path);
    let _ = fs::remove_file(&children_json_path);
    Ok(())
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
    rec.child = Some(child);
    rec.last_spawn = Instant::now();
    rec.entry = entry.clone();
    log_line(
        sup_log_path,
        &format!("spawned '{}' (pid={})", entry.name, pid),
    );
    Ok(())
}

fn reconcile(
    entries_path: &PathBuf,
    svcctl_dir: &PathBuf,
    sup_log_path: &PathBuf,
    children_json_path: &PathBuf,
    state: &mut HashMap<String, ChildRecord>,
) -> Result<(), String> {
    let bytes = fs::read(entries_path).map_err(|e| e.to_string())?;
    let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    let parsed: EntriesFile = toml::from_str(&text).map_err(|e| e.to_string())?;
    let new_names: HashSet<String> = parsed.entries.iter().map(|e| e.name.clone()).collect();

    // 1. 删 state 里没在 entries 里的
    let to_remove: Vec<String> = state
        .keys()
        .filter(|n| !new_names.contains(*n))
        .cloned()
        .collect();
    for n in to_remove {
        if let Some(mut rec) = state.remove(&n) {
            if let Some(c) = rec.child.as_mut() {
                let _ = c.kill();
                log_line(sup_log_path, &format!("killed removed entry '{}'", n));
            }
        }
    }

    // 2. spawn 新增的 / 重启改动的
    for entry in parsed.entries {
        let needs_spawn = match state.get(&entry.name) {
            None => true,
            Some(rec) => entry_changed(&rec.entry, &entry),
        };
        if needs_spawn {
            let mut rec = ChildRecord {
                child: None,
                last_spawn: Instant::now(),
                entry: entry.clone(),
            };
            if let Err(e) = spawn_one(&entry, svcctl_dir, &mut rec, sup_log_path) {
                log_line(
                    sup_log_path,
                    &format!("initial spawn '{}' failed: {}", entry.name, e),
                );
            }
            state.insert(entry.name.clone(), rec);
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
