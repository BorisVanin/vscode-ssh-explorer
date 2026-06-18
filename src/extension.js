'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');
const SSHConfig = require('ssh-config');

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
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
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

  _connect() {
    return new Promise((resolve, reject) => {
      let conf;
      try {
        conf = connectConfigFor(this.alias);
      } catch (e) { return reject(e); }

      if (conf._proxyJump) {
        return reject(new Error(
          `Host "${this.alias}" uses ProxyJump (${conf._proxyJump}), which this extension does not support yet.`));
      }

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
  }

  conn(authority) {
    let c = this.conns.get(authority);
    if (!c) { c = new Connection(authority); this.conns.set(authority, c); }
    return c;
  }

  _sftp(uri) { return this.conn(uri.authority).getSftp(); }

  disconnect(authority) {
    const c = this.conns.get(authority);
    if (c) { c.end(); this.conns.delete(authority); }
  }

  watch() { return new vscode.Disposable(() => {}); }

  async stat(uri) {
    const sftp = await this._sftp(uri);
    const p = uri.path || '/';
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

  async readDirectory(uri) {
    const sftp = await this._sftp(uri);
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

  async readFile(uri) {
    const sftp = await this._sftp(uri);
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stream = sftp.createReadStream(uri.path);
      stream.on('data', (d) => chunks.push(d));
      stream.on('error', (e) => reject(toFsError(e, uri)));
      stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    });
  }

  async writeFile(uri, content) {
    const sftp = await this._sftp(uri);
    await new Promise((resolve, reject) => {
      const ws = sftp.createWriteStream(uri.path);
      ws.on('error', (e) => reject(toFsError(e, uri)));
      ws.on('close', () => resolve());
      ws.end(Buffer.from(content));
    });
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  async createDirectory(uri) {
    const sftp = await this._sftp(uri);
    await new Promise((resolve, reject) => {
      sftp.mkdir(uri.path, (err) => err ? reject(toFsError(err, uri)) : resolve());
    });
  }

  async delete(uri, options) {
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

  async rename(oldUri, newUri) {
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
    vscode.commands.registerCommand('sshExplorer.openHost', openHost),
    vscode.commands.registerCommand('sshExplorer.disconnectHost', makeDisconnect(provider)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
