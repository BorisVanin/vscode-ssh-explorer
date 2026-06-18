'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { Client } = require('ssh2');
const SSHConfig = require('ssh-config');

// How long to wait for the TCP reachability probe before declaring a host
// offline. This is a LAN device, not the internet — an online host answers in
// milliseconds, so a short budget keeps an offline host from stalling anything.
const REACH_TIMEOUT_MS = 800;

// Quick "is the SSH port even open?" check, done before handing off to ssh2 so an
// offline LAN device fails in ~1s instead of hanging on the OS connect timeout.
// Resolves true if we can open a TCP socket to host:port, false otherwise.
function probeReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false)); // EHOSTUNREACH / ECONNREFUSED / etc.
    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// ~/.ssh/config parsing
// ---------------------------------------------------------------------------

function sshConfigPath() {
  return path.join(os.homedir(), '.ssh', 'config');
}

function loadConfig() {
  try {
    return SSHConfig.parse(fs.readFileSync(sshConfigPath(), 'utf8'));
  } catch (e) {
    return SSHConfig.parse('');
  }
}

function listHostAliases(cfg) {
  const out = [];
  for (const line of cfg) {
    if (line.param && line.param.toLowerCase() === 'host') {
      const vals = Array.isArray(line.value) ? line.value : [line.value];
      for (const v of vals) {
        if (!/[*?!]/.test(v)) out.push(v);
      }
    }
  }
  return [...new Set(out)];
}

function expandHome(p) {
  if (p && p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

// Build an ssh2 connection config from a ~/.ssh/config Host alias.
function connectConfigFor(alias) {
  const cfg = loadConfig();
  const c = cfg.compute(alias) || {};
  const host = c.HostName || alias;
  const port = c.Port ? parseInt(c.Port, 10) : 22;
  const username = c.User || os.userInfo().username;

  const identityFiles = c.IdentityFile
    ? (Array.isArray(c.IdentityFile) ? c.IdentityFile : [c.IdentityFile])
    : [];
  let privateKey;
  for (const f of identityFiles) {
    try {
      privateKey = fs.readFileSync(expandHome(f));
      break;
    } catch (e) { /* missing key file, try next */ }
  }

  const conf = {
    host,
    port,
    username,
    tryKeyboard: true,
    readyTimeout: 15000,
    // Detect a silently-dead peer (host powered off) in ~10s rather than ~45s.
    keepaliveInterval: 5000,
    keepaliveCountMax: 2,
    // 'none' first so passwordless/open hosts connect with zero prompts.
    authHandler: ['none', 'agent', 'publickey', 'keyboard-interactive', 'password'],
  };
  if (privateKey) conf.privateKey = privateKey;
  if (process.env.SSH_AUTH_SOCK) conf.agent = process.env.SSH_AUTH_SOCK;
  if (c.ProxyJump) conf._proxyJump = c.ProxyJump; // not yet implemented; surfaced in errors
  return conf;
}

// ---------------------------------------------------------------------------
// One reconnecting SSH/SFTP connection per host alias
// ---------------------------------------------------------------------------

class Connection {
  constructor(alias) {
    this.alias = alias;
    this.client = null;
    this.sftp = null;
    this.pending = null;
  }

  getSftp() {
    if (this.sftp) return Promise.resolve(this.sftp);
    if (this.pending) return this.pending;
    this.pending = this._connect();
    this.pending.finally(() => { this.pending = null; });
    return this.pending;
  }

  async _connect() {
    const conf = connectConfigFor(this.alias);

    if (conf._proxyJump) {
      throw new Error(
        `Host "${this.alias}" uses ProxyJump (${conf._proxyJump}), which this extension does not support yet.`);
    }

    // Fail fast if the device isn't on the LAN, instead of waiting on ssh2's connect.
    const reachable = await probeReachable(conf.host, conf.port, REACH_TIMEOUT_MS);
    if (!reachable) {
      throw vscode.FileSystemError.Unavailable(
        `SSH Explorer: ${this.alias} (${conf.host}:${conf.port}) is offline or unreachable.`);
    }

    return new Promise((resolve, reject) => {
      const client = new Client();
      client.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
        finish(prompts.map(() => '')); // answer all prompts with empty string
      });
      client.on('ready', () => {
        client.sftp((err, sftp) => {
          if (err) { client.end(); return reject(err); }
          this.client = client;
          this.sftp = sftp;
          resolve(sftp);
        });
      });
      client.on('error', (err) => { this._reset(); reject(err); });
      client.on('close', () => { this._reset(); });
      client.connect(conf);
    });
  }

  _reset() {
    this.sftp = null;
    this.client = null;
  }

  end() {
    if (this.client) { try { this.client.end(); } catch (e) {} }
    this._reset();
  }
}

// ---------------------------------------------------------------------------
// FileSystemProvider over SFTP
// ---------------------------------------------------------------------------

// Hard ceiling for any single filesystem operation. Without this, a request
// issued the moment a host dies hangs on the OS TCP timeout (minutes).
const OP_TIMEOUT_MS = 12000;

function fileTypeFromAttrs(a) {
  if (a.isDirectory && a.isDirectory()) return vscode.FileType.Directory;
  if (a.isFile && a.isFile()) return vscode.FileType.File;
  return vscode.FileType.Unknown;
}

function makeStat(a, type) {
  const mtime = (a.mtime || 0) * 1000;
  return { type, ctime: mtime, mtime, size: a.size || 0 };
}

function toFsError(err, uri) {
  const code = err && err.code;
  const msg = (err && err.message) || '';
  if (code === 2 || /no such file/i.test(msg)) return vscode.FileSystemError.FileNotFound(uri);
  if (code === 3 || /permission denied/i.test(msg)) return vscode.FileSystemError.NoPermissions(uri);
  return err;
}

class SSHFileSystemProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this._emitter.event;
    this.conns = new Map();

    // Offline hosts get a "!" badge in the Explorer (via FileDecorationProvider)
    // instead of error popups. _offline holds the authorities currently down.
    this._offline = new Set();
    this._decoEmitter = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._decoEmitter.event;
  }

  conn(authority) {
    let c = this.conns.get(authority);
    if (!c) { c = new Connection(authority); this.conns.set(authority, c); }
    return c;
  }

  // Get an SFTP handle, recording the host's online/offline state as a side
  // effect so the Explorer badge stays in sync. Throws (quietly handled by
  // callers) when the host is unreachable.
  async _sftp(uri) {
    try {
      const sftp = await this.conn(uri.authority).getSftp();
      this._setOffline(uri.authority, false);
      return sftp;
    } catch (e) {
      this._setOffline(uri.authority, true);
      throw e;
    }
  }

  // Flip a host's offline state and refresh its Explorer badge if it changed.
  _setOffline(authority, offline) {
    if (offline === this._offline.has(authority)) return;
    if (offline) this._offline.add(authority); else this._offline.delete(authority);
    const uris = (vscode.workspace.workspaceFolders || [])
      .filter((f) => f.uri.scheme === 'sshx' && f.uri.authority === authority)
      .map((f) => f.uri);
    this._decoEmitter.fire(uris.length ? uris : undefined);
  }

  // FileDecorationProvider: show a "!" next to an offline host's folder.
  provideFileDecoration(uri) {
    if (uri.scheme === 'sshx' && this._offline.has(uri.authority)) {
      return {
        badge: '!',
        tooltip: 'SSH Explorer: host is offline or unreachable',
        color: new vscode.ThemeColor('list.warningForeground'),
        propagate: false, // don't bubble up to the parent — show a single "!"
      };
    }
    return undefined;
  }

  // Kick off a connection in the background and refresh the tree once it's ready.
  // Used so the Explorer never blocks on connect — it renders immediately and
  // fills in when (if) the host answers. Offline hosts just get the "!" badge.
  _warm(uri) {
    this._sftp(uri).then(
      () => this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]),
      () => {} // unreachable: badge already set by _sftp; no spinner, no popup
    );
  }

  // Backstop for the two operations VS Code calls automatically: if a host dies
  // mid-session, keepalive (~10s) normally rejects in-flight calls, but this
  // guarantees the UI can never freeze on stat/readDirectory.
  _withTimeout(uri, promise) {
    promise.catch(() => {}); // swallow a late rejection if the timeout already won
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.disconnect(uri.authority);
        this._setOffline(uri.authority, true);
        reject(vscode.FileSystemError.Unavailable(
          `SSH Explorer: ${uri.authority} is not responding (timed out after ${OP_TIMEOUT_MS / 1000}s).`));
      }, OP_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  disconnect(authority) {
    const c = this.conns.get(authority);
    if (c) { c.end(); this.conns.delete(authority); }
  }

  watch() { return new vscode.Disposable(() => {}); }

  // stat/readDirectory are timeout-guarded (auto-called, must never freeze the UI).
  // Data/bulk ops run uncapped so large transfers aren't cut off; they rely on
  // keepalive to fail on a dead host.
  stat(uri) { return this._withTimeout(uri, this._stat(uri)); }
  readDirectory(uri) { return this._withTimeout(uri, this._readDirectory(uri)); }
  readFile(uri) { return this._readFile(uri); }
  writeFile(uri, content) { return this._writeFile(uri, content); }
  createDirectory(uri) { return this._createDirectory(uri); }
  delete(uri, options) { return this._delete(uri, options); }
  rename(oldUri, newUri) { return this._rename(oldUri, newUri); }

  async _stat(uri) {
    const conn = this.conn(uri.authority);
    const p = uri.path || '/';
    // Not connected yet → don't block. Render the root as a directory instantly so
    // the folder node shows, and connect in the background. Deeper paths aren't
    // known until connected, so report them as not-found (quiet) for now.
    if (!conn.sftp) {
      this._warm(uri);
      if (p === '/' || p === '') {
        return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
      }
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const sftp = conn.sftp;
    return new Promise((resolve, reject) => {
      sftp.lstat(p, (err, st) => {
        if (err) return reject(toFsError(err, uri));
        if (st.isSymbolicLink && st.isSymbolicLink()) {
          sftp.stat(p, (e2, st2) => {
            if (e2) return resolve(makeStat(st, vscode.FileType.SymbolicLink));
            resolve(makeStat(st2, fileTypeFromAttrs(st2) | vscode.FileType.SymbolicLink));
          });
        } else {
          resolve(makeStat(st, fileTypeFromAttrs(st)));
        }
      });
    });
  }

  async _readDirectory(uri) {
    const conn = this.conn(uri.authority);
    // Connect on expand: each time a not-yet-connected host is unfolded, actually
    // try to reach it. The fast probe bounds this to ~1s, so an offline host falls
    // through to an empty tree + "!" badge instead of blocking. (We don't rely on
    // a background refresh event — VS Code doesn't reliably re-list a folder from
    // one, which is why it previously only filled in after a manual refresh.)
    let sftp = conn.sftp;
    if (!sftp) {
      try {
        sftp = await this._sftp(uri);
      } catch (e) {
        return []; // offline/unreachable: empty tree; _sftp already set the badge
      }
    }
    const dir = uri.path || '/';
    const list = await new Promise((resolve, reject) => {
      sftp.readdir(dir, (err, l) => err ? reject(toFsError(err, uri)) : resolve(l));
    });
    const base = dir.replace(/\/+$/, '');
    return Promise.all(list.map((e) => new Promise((resolve) => {
      const a = e.attrs;
      if (a.isSymbolicLink && a.isSymbolicLink()) {
        // Resolve the link target so symlinked dirs are expandable.
        sftp.stat(base + '/' + e.filename, (err, st) => {
          const t = err ? vscode.FileType.Unknown : fileTypeFromAttrs(st);
          resolve([e.filename, t | vscode.FileType.SymbolicLink]);
        });
      } else {
        resolve([e.filename, fileTypeFromAttrs(a)]);
      }
    })));
  }

  async _readFile(uri) {
    let sftp;
    try {
      sftp = await this._sftp(uri);
    } catch (e) {
      // Host offline/unreachable. Report not-found rather than a loud "Unavailable"
      // so background language servers (Pylance, etc.) skip the file quietly
      // instead of popping a notification. The "!" badge already signals the state.
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = sftp.createReadStream(uri.path);
      stream.on('data', (d) => chunks.push(d));
      stream.on('error', (e) => reject(toFsError(e, uri)));
      stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    });
  }

  async _writeFile(uri, content) {
    const sftp = await this._sftp(uri);
    await new Promise((resolve, reject) => {
      const ws = sftp.createWriteStream(uri.path);
      ws.on('error', (e) => reject(toFsError(e, uri)));
      ws.on('close', () => resolve());
      ws.end(Buffer.from(content));
    });
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async _createDirectory(uri) {
    const sftp = await this._sftp(uri);
    await new Promise((resolve, reject) => {
      sftp.mkdir(uri.path, (err) => err ? reject(toFsError(err, uri)) : resolve());
    });
  }

  async _delete(uri, options) {
    const sftp = await this._sftp(uri);
    await this._rm(sftp, uri.path, options && options.recursive, uri);
    this._emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async _rm(sftp, p, recursive, uri) {
    const st = await new Promise((resolve, reject) =>
      sftp.lstat(p, (e, s) => e ? reject(toFsError(e, uri)) : resolve(s)));
    if (st.isDirectory && st.isDirectory()) {
      if (recursive) {
        const list = await new Promise((resolve, reject) =>
          sftp.readdir(p, (e, l) => e ? reject(toFsError(e, uri)) : resolve(l)));
        const base = p.replace(/\/+$/, '');
        for (const e of list) await this._rm(sftp, base + '/' + e.filename, true, uri);
      }
      await new Promise((resolve, reject) =>
        sftp.rmdir(p, (e) => e ? reject(toFsError(e, uri)) : resolve()));
    } else {
      await new Promise((resolve, reject) =>
        sftp.unlink(p, (e) => e ? reject(toFsError(e, uri)) : resolve()));
    }
  }

  async _rename(oldUri, newUri) {
    const sftp = await this._sftp(oldUri);
    await new Promise((resolve, reject) =>
      sftp.rename(oldUri.path, newUri.path, (e) => e ? reject(toFsError(e, oldUri)) : resolve()));
    this._emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function openHost() {
  const aliases = listHostAliases(loadConfig())
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  if (!aliases.length) {
    vscode.window.showErrorMessage('SSH Explorer: no Host entries found in ~/.ssh/config');
    return;
  }
  const alias = await vscode.window.showQuickPick(aliases, {
    placeHolder: 'Pick an SSH host from ~/.ssh/config',
  });
  if (!alias) return;

  const root = await vscode.window.showInputBox({
    prompt: `Remote folder to open on ${alias}`,
    value: '/',
  });
  if (root === undefined) return;
  const rootPath = root.startsWith('/') ? root : '/' + root;

  const uri = vscode.Uri.parse(`sshx://${alias}${rootPath}`);
  const idx = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0;
  vscode.workspace.updateWorkspaceFolders(idx, 0, { uri, name: `${alias}${rootPath === '/' ? '' : ':' + rootPath}` });
}

function makeDisconnect(provider) {
  return async function disconnectHost() {
    const active = [...provider.conns.keys()];
    if (!active.length) {
      vscode.window.showInformationMessage('SSH Explorer: no active connections.');
      return;
    }
    const alias = await vscode.window.showQuickPick(active, {
      placeHolder: 'Disconnect which host? (clears a stuck session)',
    });
    if (!alias) return;
    provider.disconnect(alias);
    vscode.window.showInformationMessage(`SSH Explorer: disconnected ${alias}.`);
  };
}

function activate(context) {
  const provider = new SSHFileSystemProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('sshx', provider, { isCaseSensitive: true }),
    vscode.window.registerFileDecorationProvider(provider),
    vscode.commands.registerCommand('sshExplorer.openHost', openHost),
    vscode.commands.registerCommand('sshExplorer.disconnectHost', makeDisconnect(provider)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
