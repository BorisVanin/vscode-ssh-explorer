# Changelog

All notable changes to this extension are documented here.

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
