# Changelog

All notable changes to this extension are documented here.

## [0.1.1] - 2026-06-18

### Fixed
- The Explorer no longer stalls on an offline host. The folder node renders
  immediately; expanding a host connects on demand, and a fast TCP reachability
  probe (~0.8s) before the SSH handshake means an offline LAN device falls through
  to an empty tree quickly instead of stalling on the OS connect timeout.
- A silently-dead host (powered off without a clean disconnect) is detected in
  ~10s via tightened SSH keepalive; stat/readDirectory have a backstop timeout so
  the UI can never freeze.
- An offline host now shows a `!` badge on its folder in the Explorer instead of
  raising error notifications. Background access (e.g. language servers like
  Pylance scanning the workspace) fails quietly rather than popping dialogs.

### Changed
- Extension id renamed to `ssh-config-explorer` (the display name is unchanged).

## [0.1.0] - 2026-06-18

### Added
- Browse remote folders in the VS Code Explorer over SFTP.
- Resolve hosts from `~/.ssh/config` (`HostName`/`User`/`Port`/`IdentityFile`).
- **SSH Explorer: Open Host…** command, with the host list sorted alphabetically.
- **SSH Explorer: Disconnect Host…** command to drop a stuck session.
- Read, write, create, rename, and delete over SFTP.

### Known limitations
- `ProxyJump` is not implemented yet (direct connections only).
- File watching is a no-op — refresh a folder to see external changes.
- Interactive password entry is not wired up yet.
