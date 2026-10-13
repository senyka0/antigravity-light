import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AppPaths, isWindows } from './paths.js';

export class KeyringManager {
  /**
   * Reads credentials stored in OS Keyring or fallback files
   */
  static getCredentials() {
    // 1. Try python / CLI keyring
    const keyringCommands = [
      ['/home/whoami/.pyenv/shims/keyring', ['get', 'gemini', 'antigravity']],
      ['keyring', ['get', 'gemini', 'antigravity']],
      ['python3', ['-m', 'keyring', 'get', 'gemini', 'antigravity']],
      ['python', ['-m', 'keyring', 'get', 'gemini', 'antigravity']],
    ];

    for (const [cmd, args] of keyringCommands) {
      try {
        const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        if (res.status === 0 && res.stdout?.trim()) {
          const parsed = JSON.parse(res.stdout.trim());
          if (parsed.token?.access_token || parsed.token?.refresh_token) {
            return parsed;
          }
        }
      } catch {}
    }

    // 2. Try secret-tool on Linux
    if (!isWindows) {
      try {
        const res = spawnSync('secret-tool', ['lookup', 'service', 'gemini', 'username', 'antigravity'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (res.status === 0 && res.stdout?.trim()) {
          const parsed = JSON.parse(res.stdout.trim());
          return parsed;
        }
      } catch {}
    }

    // 3. Fallback: check ~/.gemini/jetski-standalone-oauth-token
    try {
      const standalone = AppPaths.getStandaloneOAuthTokenPath();
      if (fs.existsSync(standalone)) {
        return JSON.parse(fs.readFileSync(standalone, 'utf8'));
      }
    } catch {}

    return null;
  }

  /**
   * Persists OAuth credentials to OS Keyring (gemini/antigravity) and fallback files
   */
  static setCredentials(account) {
    const expiryIso = new Date(account.expiresAt || Date.now() + 3600000).toISOString();
    const payload = {
      token: {
        access_token: account.accessToken,
        token_type: 'Bearer',
        refresh_token: account.refreshToken,
        expiry: expiryIso,
      },
      auth_method: 'consumer',
      id_token: account.idToken || '',
    };
    const payloadStr = JSON.stringify(payload);

    let keyringSaved = false;

    // 1. Try Python keyring on Linux/Windows/Mac
    const keyringCommands = [
      ['/home/whoami/.pyenv/shims/keyring', ['set', 'gemini', 'antigravity']],
      ['keyring', ['set', 'gemini', 'antigravity']],
      ['python3', ['-m', 'keyring', 'set', 'gemini', 'antigravity']],
      ['python', ['-m', 'keyring', 'set', 'gemini', 'antigravity']],
    ];

    for (const [cmd, args] of keyringCommands) {
      try {
        const res = spawnSync(cmd, args, {
          input: payloadStr,
          encoding: 'utf8',
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        if (res.status === 0) {
          keyringSaved = true;
          console.log(`[KeyringManager] Successfully updated OS Keyring via ${cmd}`);
          break;
        }
      } catch {}
    }

    // 2. If Linux and secret-tool is available
    if (!keyringSaved && !isWindows) {
      try {
        const res = spawnSync(
          'secret-tool',
          ['store', '--label="Password for \'antigravity\' on \'gemini\'"', 'service', 'gemini', 'username', 'antigravity'],
          {
            input: payloadStr,
            encoding: 'utf8',
            stdio: ['pipe', 'ignore', 'ignore'],
          },
        );
        if (res.status === 0) {
          keyringSaved = true;
          console.log('[KeyringManager] Successfully updated OS Keyring via secret-tool');
        }
      } catch {}
    }

    // 3. If Windows and PowerShell Credential Manager
    if (!keyringSaved && isWindows) {
      try {
        const psScript = `
          $bytes = [System.Text.Encoding]::UTF8.GetBytes('${payloadStr.replace(/'/g, "''")}');
          $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length);
          [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length);
          # Fallback cmdkey or Windows PasswordVault
          cmdkey /generic:gemini /user:antigravity /pass:'${payloadStr.replace(/'/g, "''")}';
        `;
        spawnSync('powershell', ['-NoProfile', '-Command', psScript], { stdio: 'ignore' });
        keyringSaved = true;
      } catch {}
    }

    // 4. Always update ~/.gemini/jetski-standalone-oauth-token
    try {
      const standalone = AppPaths.getStandaloneOAuthTokenPath();
      const parent = path.dirname(standalone);
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }
      fs.writeFileSync(
        standalone,
        JSON.stringify({
          token: payload.token,
          auth_method: 'consumer',
          email: account.email,
        }),
        { mode: 0o600 },
      );
      console.log(`[KeyringManager] Updated ${standalone}`);
    } catch (err) {
      console.warn(`[KeyringManager] Failed to write standalone token: ${err.message}`);
    }

    return keyringSaved;
  }
}
