# svcctl (service control)

Cross-platform system startup supervisor. Register any command as a user-level autostart item on Windows, macOS, and Linux with one CLI.

## Quick start

```bash
# Add a command — first add also installs the OS-level supervisor
svcctl add bunx cctra

# List registered entries
svcctl ls

# View logs
svcctl log bunx-cctra
svcctl log bunx-cctra -f   # follow

# Remove
svcctl remove bunx-cctra

# Status
svcctl status
```

## How it works

svcctl installs **one** OS-level autostart item (HKCU\Run on Windows, LaunchAgent on macOS, systemd user unit on Linux) that runs a **supervisor process**. The supervisor reads `~/.svcctl/entries.toml` and launches all added commands at boot, redirecting each command's stdout/stderr to `~/.svcctl/logs/<name>.log`.

Adding or removing entries **hot-reloads** the supervisor — no restart needed:
- macOS / Linux: `fs.watch` on entries.toml (event-driven, < 100ms)
- Windows: mtime check piggybacked on the reap loop (< 1s)

## Install (development)

```bash
bun install
bun run build:launcher  # Windows only — build svcctl-supervisor.exe
```

## License

MIT
