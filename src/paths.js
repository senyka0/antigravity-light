import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export const isWindows = process.platform === 'win32';

export class AppPaths {
  /**
   * Root config directory for this light app
   */
  static getLightAppDir() {
    const dir = path.join(os.homedir(), '.antigravity-light');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  static getAccountsFilePath() {
    return path.join(this.getLightAppDir(), 'accounts.json');
  }

  static getConfigFilePath() {
    return path.join(this.getLightAppDir(), 'config.json');
  }

  /**
   * Returns potential locations of Antigravity's state.vscdb
   */
  static getAntigravityStateDbCandidates() {
    const candidates = [];
    if (isWindows) {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      candidates.push(path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
      candidates.push(path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
      candidates.push(path.join(appData, 'Antigravity', 'User', 'state.vscdb'));
    } else {
      // Linux
      candidates.push(path.join(os.homedir(), '.config', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'));
      candidates.push(path.join(os.homedir(), '.config', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'));
      candidates.push(path.join(os.homedir(), '.config', 'Antigravity', 'User', 'state.vscdb'));
    }
    return candidates;
  }

  /**
   * Returns the first existing state.vscdb path, or primary default candidate
   */
  static getAntigravityStateDb() {
    const candidates = this.getAntigravityStateDbCandidates();
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  }

  /**
   * Location of Antigravity desktop app_storage.json
   */
  static getAntigravityAppStorageCandidates() {
    const candidates = [];
    if (isWindows) {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      candidates.push(path.join(appData, 'Antigravity', 'app_storage.json'));
      candidates.push(path.join(appData, 'Antigravity IDE', 'app_storage.json'));
    } else {
      candidates.push(path.join(os.homedir(), '.config', 'Antigravity', 'app_storage.json'));
      candidates.push(path.join(os.homedir(), '.config', 'Antigravity IDE', 'app_storage.json'));
    }
    return candidates;
  }

  static getAntigravityAppStorage() {
    const candidates = this.getAntigravityAppStorageCandidates();
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  }

  /**
   * Standalone jetski OAuth token file
   */
  static getStandaloneOAuthTokenPath() {
    return path.join(os.homedir(), '.gemini', 'jetski-standalone-oauth-token');
  }

  /**
   * Conversations summaries DB path
   */
  static getConversationsDb() {
    return path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
  }

  /**
   * Conversation locks directory
   */
  static getPresenceDir() {
    return path.join(os.homedir(), '.gemini', 'antigravity', 'presence');
  }

  /**
   * DevTools Active Port file candidates across platforms
   */
  static getDevToolsPortFileCandidates() {
    const candidates = [];
    if (isWindows) {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      candidates.push(path.join(appData, 'Antigravity', 'DevToolsActivePort'));
      candidates.push(path.join(appData, 'Antigravity IDE', 'DevToolsActivePort'));
      candidates.push(path.join(localAppData, 'Antigravity', 'DevToolsActivePort'));
    } else {
      candidates.push(path.join(os.homedir(), '.config', 'Antigravity', 'DevToolsActivePort'));
      candidates.push(path.join(os.homedir(), '.config', 'Antigravity IDE', 'DevToolsActivePort'));
    }
    return candidates;
  }

  static getDevToolsPortFile() {
    const candidates = this.getDevToolsPortFileCandidates();
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  }

  /**
   * Resolved path to `agy` CLI binary
   */
  static getAgyCli() {
    if (isWindows) {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const candidates = [
        path.join(localAppData, 'Programs', 'Antigravity', 'bin', 'agy.cmd'),
        path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agy.exe'),
        'agy',
      ];
      return candidates.find((p) => fs.existsSync(p)) || 'agy';
    } else {
      const candidates = [
        path.join(os.homedir(), '.local', 'bin', 'agy'),
        path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agy'),
        '/usr/local/bin/agy',
        'agy',
      ];
      return candidates.find((p) => fs.existsSync(p)) || 'agy';
    }
  }

  /**
   * Cloud Code User-Agent
   */
  static getUserAgent() {
    const osTag = isWindows ? 'windows' : 'linux';
    const archTag = process.arch === 'x64' ? 'amd64' : process.arch;
    return `antigravity/2.23.0 ${osTag}/${archTag}`;
  }
}
