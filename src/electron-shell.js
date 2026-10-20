import fs from 'node:fs';
import { AppPaths } from './paths.js';

export class ElectronShellManager {
  /**
   * Updates Electron's in-memory StorageManager and syncs active account in UI.
   */
  static async syncAccount(account) {
    const devToolsFile = AppPaths.getDevToolsPortFile();
    if (!devToolsFile || !fs.existsSync(devToolsFile)) {
      return false;
    }

    let port = null;
    try {
      port = parseInt(fs.readFileSync(devToolsFile, 'utf8').split('\n')[0], 10);
    } catch {
      return false;
    }

    if (!port || isNaN(port)) {
      return false;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (!res.ok) return false;
      const targets = await res.json();
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);

      if (pages.length === 0) return false;

      // Update nativeStorage on the first available page target
      // (This triggers IPC storage:update-items to Electron main process,
      // which syncs in-memory StorageManager and broadcasts storage:changed to all windows)
      const target = pages[0];
      const success = await new Promise((resolve) => {
        let ws;
        try {
          ws = new WebSocket(target.webSocketDebuggerUrl);
        } catch {
          return resolve(false);
        }

        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          resolve(false);
        }, 3000);

        ws.onopen = () => {
          const expression = `(async () => {
            if (typeof window.nativeStorage !== 'undefined') {
              await window.nativeStorage.updateItems({
                'jetski.onboarding.lastLoginUsername': ${JSON.stringify(account.email)},
                'antigravity.lastLoginUsername': ${JSON.stringify(account.email)}
              });
              return true;
            }
            return false;
          })()`;

          ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression,
              awaitPromise: true,
              returnByValue: true,
            },
          }));
        };

        ws.onmessage = (e) => {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(true);
        };

        ws.onerror = () => {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(false);
        };
      });

      if (success) {
        console.log(`[ElectronShellManager] Successfully updated Electron nativeStorage for ${account.email}`);
      }
      return success;
    } catch (err) {
      console.warn(`[ElectronShellManager] Could not update Electron nativeStorage: ${err.message}`);
      return false;
    }
  }

  /**
   * Refreshes Electron window(s) to re-render UI with active credentials
   */
  static async reloadWindows() {
    const devToolsFile = AppPaths.getDevToolsPortFile();
    if (!devToolsFile || !fs.existsSync(devToolsFile)) return false;

    let port = null;
    try {
      port = parseInt(fs.readFileSync(devToolsFile, 'utf8').split('\n')[0], 10);
    } catch {
      return false;
    }

    if (!port || isNaN(port)) return false;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (!res.ok) return false;
      const targets = await res.json();
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);

      for (const page of pages) {
        await new Promise((resolve) => {
          let ws;
          try {
            ws = new WebSocket(page.webSocketDebuggerUrl);
          } catch {
            return resolve();
          }

          const timer = setTimeout(() => {
            try { ws.close(); } catch {}
            resolve();
          }, 2000);

          ws.onopen = () => {
            ws.send(JSON.stringify({
              id: 1,
              method: 'Page.reload',
              params: { ignoreCache: true },
            }));
            setTimeout(() => {
              try { ws.close(); } catch {}
              resolve();
            }, 500);
          };

          ws.onerror = () => {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve();
          };
        });
      }
      return true;
    } catch {
      return false;
    }
  }
}
