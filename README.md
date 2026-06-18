# SSH Explorer (.ssh/config aware)

> [!IMPORTANT]
> **🤖 This entire project was written by Claude — Anthropic's Claude Opus 4.8 —
> working in Claude Code.** Every line of source, the build system, the docs, and
> this README were authored by the model under human direction. Keep that in mind
> when reading, reusing, or auditing the code.

Browse remote folders in the VS Code Explorer over **SFTP**, resolving hosts from
your `~/.ssh/config`. No `vscode-server` install on the target, no FUSE mount.

**[Install from the VS Code Marketplace »](https://marketplace.visualstudio.com/items?itemName=BorisVanin.ssh-config-explorer)**

## Why

- **Reads `~/.ssh/config`** — pick a `Host` alias (for example to connect to your
  Le Potato device `potato`) and it uses the resolved
  `HostName`/`User`/`Port`/`IdentityFile`, exactly like `ssh potato`.
- **Shows files in the Explorer** — adds the remote path as a workspace folder.
- **Reboot-safe** — it's SFTP over `ssh2`, not a FUSE mount. A dropped connection
  surfaces as an error and reconnects on the next action; it can never wedge the OS
  the way `sshfs` does when a device reboots without unmounting.

## Use

1. Command Palette → **SSH Explorer: Open Host…**
2. Pick a host from `~/.ssh/config`, accept the folder (default `/`).
3. The remote folder appears in the Explorer.

**SSH Explorer: Disconnect Host…** force-drops a session if one ever gets stuck.

## How it compares

| Extension | Approach | Needs remote install | Reads `~/.ssh/config` | Notes |
|---|---|---|---|---|
| **SSH Explorer** (this) | SFTP filesystem in the Explorer | No | **Yes, directly** | Tiny; zero config; host picker sorted A→Z |
| Remote - SSH (Microsoft) | Full remote workspace | **Yes** (`vscode-server`) | Yes | Heavyweight; can't run on restricted/locked-down hosts |
| SSH FS (Kelvin) | SFTP filesystem provider | No | Partial (import/hop) | Larger feature set, own config UI, supports SSH hops/ProxyJump |
| SFTP (Natizyskunk / liximomo) | Upload/download sync | No | No (uses `sftp.json`) | Edit-locally, sync-on-save; not a live remote filesystem |

**Key differences of SSH Explorer:**

- vs **Remote - SSH** — installs nothing on the target. No `vscode-server` binary, so it
  works on appliances, routers, and locked-down hosts where you can't (or won't) run a server.
- vs **SSH FS** — reads `~/.ssh/config` natively (no separate config to maintain) and stays
  deliberately minimal. SSH FS is more featureful (config editor, terminals, SSH hops) but heavier.
- vs **SFTP-sync extensions** — files are live over SFTP, not a local copy you sync. There's no
  `sftp.json`, no upload-on-save step, and no risk of local/remote drift.
- **Reboot-safe by design** — it's SFTP over `ssh2`, not a FUSE mount like `sshfs`, so a target
  rebooting without unmounting can never wedge your OS.

## Limitations

- `ProxyJump` is not implemented yet (direct connections only).
- File watching is a no-op — refresh a folder to see external changes.
- Passwordless / key / agent / `none` auth work without prompts. Interactive
  password entry is not wired up yet.

## License

MIT — see [LICENSE](LICENSE).

The code in this repository was written by Anthropic's **Claude Opus 4.8** via
Claude Code, under human direction.
