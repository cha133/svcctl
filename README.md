# svcctl (service control)

Cross-platform user-level autostart with a single supervisor process. Register any command to auto-start at login on Windows, macOS, and Linux — the supervisor keeps each child alive, captures logs, and hot-reloads on changes.

## Quick start

```bash
# Add a command — first add also installs the OS-level supervisor
svcctl add bunx cctra

# Opt-in auto-restart on crash (default: don't restart)
svcctl add bunx cctra --restart

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

### Manual vs auto vs auto-restart

Each entry has two independent knobs in `~/.config/svcctl/entries.toml`:

| Field      | Default | Meaning                                                    |
|------------|---------|------------------------------------------------------------|
| `startup`  | `true`  | `false` = manual only (supervisor won't spawn at boot)    |
| `restart`  | `false` | `true` = opt-in auto-restart on child exit                 |

- `startup = false` (manual) entry won't be spawned when the supervisor starts.
  Run `svcctl start <name>` to launch it.
- `restart = true` opts into auto-restart when the child dies. Default is **off**
  — most programs have internal try/catch and supervisor restart is extra
  complexity you probably don't need.

## How it works

svcctl installs **one** OS-level autostart item (HKCU\Run on Windows, LaunchAgent on macOS, systemd user unit on Linux) that runs a **supervisor process**. The supervisor reads `~/.config/svcctl/entries.toml` and launches all added commands at boot, redirecting each command's stdout/stderr to `~/.local/state/svcctl/logs/<name>.log`.

Adding or removing entries **hot-reloads** the supervisor — no restart needed:
- macOS / Linux: `fs.watch` on entries.toml (event-driven, < 100ms)
- Windows: mtime check piggybacked on the reap loop (< 1s)

## Install (development)

```bash
bun install
bun run build:launcher   # Windows only — build the native supervisor package
```

The JavaScript CLI is published as `svcctl`. Windows supervisor binaries are
installed on demand from npm optional dependencies:

```text
svcctl
├── svcctl-win32-x64
└── svcctl-win32-arm64
```

Only the package matching `process.platform` and `process.arch` is installed.
To cross-compile both Windows packages on an x64 Windows machine with the x64
and ARM64 Visual C++ tools installed, run `bun run build:platforms`.

## Changing the icon

Source image lives in `launcher/assets/svcctl-source.png` (a backup of whatever you last fed to `build-icon.ps1`).

```bash
# Edit the source (1024x1024 RGBA PNG recommended; 球+halo should fill the canvas)
# Then rebuild icon + the native supervisor package in one shot:
bun run build:icon -Source /path/to/your/new-orb.png
bun run build:launcher
# or just:
bun run build:all -Source /path/to/your/new-orb.png
```

The icon shows up in Task Manager as `svcctl` (FileDescription) with the new orb glyph.

## Bumping the version

Versions live in two places that **must stay in sync**: `package.json` (npm CLI) and `launcher/Cargo.toml` (Rust supervisor). Both the VERSIONINFO on the .exe and the npm-published version come from these.

```bash
# Bump the main package, both platform packages, Cargo.toml, and bun.lock:
bun run bump 0.4.0
# or:
pwsh scripts/bump-version.ps1 0.4.0
```

Release binaries are deliberately not built by the bump script; GitHub Actions
builds them from the tagged commit. After the script finishes:

```bash
git diff -- package.json packages launcher/Cargo.toml launcher/Cargo.lock bun.lock
git add -- package.json packages/svcctl-win32-*/package.json launcher/Cargo.toml launcher/Cargo.lock bun.lock
git commit -m "v0.4.0"
git tag v0.4.0
git push origin main v0.4.0
```

## Publishing

`.github/workflows/publish.yml` verifies the tag and synchronized versions,
builds and checks the x64 and ARM64 PE files, runs the test suite, creates all
three npm tarballs, and publishes missing packages with `npm publish`. Trusted
Publishing authenticates the workflow through OIDC, so releases after the
initial platform-package bootstrap require no npm token or interactive 2FA.

Publishing uses npm Trusted Publishing (OIDC), so the workflow does not need an
`NPM_TOKEN`. Configure each npm package with this publisher after it exists:

```text
Provider: GitHub Actions
User or organization: cha133
Repository: svcctl
Workflow: publish.yml
Environment: npm-release
Allowed action: npm publish
```

The two platform package names must be bootstrapped once because npm cannot
configure Trusted Publishing for a package that does not exist yet.
For the first release, download the `npm-release-v<version>` artifact produced
by the workflow and manually publish these two tarballs with 2FA:

```bash
npm publish svcctl-win32-x64-<version>.tgz --access public
npm publish svcctl-win32-arm64-<version>.tgz --access public
```

Then configure Trusted Publishing for both packages and rerun the release by
updating the tag to the latest release commit. It skips versions already live
on npm and publishes the main package automatically.

## License

MIT
