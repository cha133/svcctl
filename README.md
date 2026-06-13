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
bun run build:all        # Windows only — regenerate icon + build SvcCtl.exe
```

If you only need to rebuild without changing the icon:

```bash
bun run build:launcher   # cargo build only
```

## Changing the icon

Source image lives in `launcher/assets/svcctl-source.png` (a backup of whatever you last fed to `build-icon.ps1`).

```bash
# Edit the source (1024x1024 RGBA PNG recommended; 球+halo should fill the canvas)
# Then rebuild icon + exe in one shot:
bun run build:icon -Source /path/to/your/new-orb.png
bun run build:launcher
# or just:
bun run build:all -Source /path/to/your/new-orb.png
```

The icon shows up in Task Manager as `svcctl` (FileDescription) with the new orb glyph.

## Bumping the version

Versions live in two places that **must stay in sync**: `package.json` (npm CLI) and `launcher/Cargo.toml` (Rust supervisor). Both the VERSIONINFO on the .exe and the npm-published version come from these.

```bash
# Bump both + rebuild in one shot:
bun run bump 0.4.0
# or:
pwsh scripts/bump-version.ps1 0.4.0
```

The script validates the semver, updates both files, and calls `build-all.ps1` to rebuild. After it finishes:

```bash
git diff package.json launcher/Cargo.toml
git add -A && git commit -m "v0.4.0"
```

## License

MIT
