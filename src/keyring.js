import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AppPaths, isWindows } from './paths.js';

export class KeyringManager {
  /**
   * Reads credentials stored in OS Keyring or fallback files
   */
  static getCredentials() {
    // 1. Try Linux native DBus Secret Service via python3 dbus
    if (!isWindows) {
      const dbusCreds = this.getLinuxDbusCredentials();
      if (dbusCreds) {
        return dbusCreds;
      }
    }

    // 2. Try python / CLI keyring
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

    // 3. Try secret-tool on Linux
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

    // 4. Fallback: check ~/.gemini/jetski-standalone-oauth-token
    try {
      const standalone = AppPaths.getStandaloneOAuthTokenPath();
      if (fs.existsSync(standalone)) {
        return JSON.parse(fs.readFileSync(standalone, 'utf8'));
      }
    } catch {}

    return null;
  }

  /**
   * Reads credentials directly from Linux DBus Secret Service (GNOME Keyring)
   */
  static getLinuxDbusCredentials() {
    const pyScript = `
import dbus, json, sys
try:
    bus = dbus.SessionBus()
    service = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")
    search_results = service.SearchItems({
        "service": "gemini",
        "username": "antigravity"
    }, dbus_interface="org.freedesktop.Secret.Service")
    items = list(search_results[0]) + list(search_results[1])
    if items:
        session_path = service.OpenSession("plain", dbus.String("", variant_level=1), dbus_interface="org.freedesktop.Secret.Service")[1]
        item = bus.get_object("org.freedesktop.secrets", items[0])
        secret = item.GetSecret(session_path, dbus_interface="org.freedesktop.Secret.Item")
        sys.stdout.write(bytes(secret[2]).decode("utf-8"))
except Exception:
    sys.exit(1)
`;
    try {
      const res = spawnSync('python3', ['-c', pyScript], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (res.status === 0 && res.stdout?.trim()) {
        const parsed = JSON.parse(res.stdout.trim());
        if (parsed.token?.access_token || parsed.token?.refresh_token) {
          return parsed;
        }
      }
    } catch {}
    return null;
  }

  /**
   * Writes credentials directly to Linux DBus Secret Service (GNOME Keyring)
   */
  static setLinuxDbusCredentials(payloadStr) {
    const pyScript = `
import dbus, json, sys
try:
    payload_str = sys.stdin.read().strip()
    if not payload_str:
        sys.exit(1)
    bus = dbus.SessionBus()
    service = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")
    session_path = service.OpenSession("plain", dbus.String("", variant_level=1), dbus_interface="org.freedesktop.Secret.Service")[1]
    search_results = service.SearchItems({
        "service": "gemini",
        "username": "antigravity"
    }, dbus_interface="org.freedesktop.Secret.Service")
    items = list(search_results[0]) + list(search_results[1])
    secret_struct = dbus.Struct((
        session_path,
        dbus.Array([], signature="y"),
        dbus.ByteArray(payload_str.encode("utf-8")),
        dbus.String("text/plain")
    ), signature="oayays")
    if items:
        item = bus.get_object("org.freedesktop.secrets", items[0])
        item.SetSecret(secret_struct, dbus_interface="org.freedesktop.Secret.Item")
    else:
        default_col = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets/aliases/default")
        props = {
            "org.freedesktop.Secret.Item.Label": dbus.String("Password for 'antigravity' on 'gemini'"),
            "org.freedesktop.Secret.Item.Attributes": dbus.Dictionary({
                "service": dbus.String("gemini"),
                "username": dbus.String("antigravity"),
                "xdg:schema": dbus.String("org.freedesktop.Secret.Generic")
            }, signature="ss")
        }
        default_col.CreateItem(props, secret_struct, True, dbus_interface="org.freedesktop.Secret.Collection")
    sys.exit(0)
except Exception:
    sys.exit(1)
`;
    try {
      const res = spawnSync('python3', ['-c', pyScript], {
        input: payloadStr,
        encoding: 'utf8',
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return res.status === 0;
    } catch {
      return false;
    }
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
      email: account.email,
    };
    const payloadStr = JSON.stringify(payload);

    let keyringSaved = false;

    // 1. Try Linux native DBus Secret Service
    if (!isWindows) {
      keyringSaved = this.setLinuxDbusCredentials(payloadStr);
      if (keyringSaved) {
        console.log(`[KeyringManager] Successfully updated Linux DBus Secret Service (GNOME Keyring) for ${account.email}`);
      }
    }

    // 2. Try Python keyring on Linux/Windows/Mac if not yet saved
    if (!keyringSaved) {
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
    }

    // 3. If Linux and secret-tool is available
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

    // 4. If Windows and PowerShell Credential Manager
    if (!keyringSaved && isWindows) {
      try {
        const psScript = `
          $bytes = [System.Text.Encoding]::UTF8.GetBytes('${payloadStr.replace(/'/g, "''")}');
          $ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length);
          [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length);
          cmdkey /generic:gemini /user:antigravity /pass:'${payloadStr.replace(/'/g, "''")}';
        `;
        spawnSync('powershell', ['-NoProfile', '-Command', psScript], { stdio: 'ignore' });
        keyringSaved = true;
      } catch {}
    }

    // 5. Always update ~/.gemini/jetski-standalone-oauth-token
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
