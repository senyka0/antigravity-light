import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { AppPaths } from './paths.js';

export class AccountDetector {
  /**
   * Detects the currently active account in Antigravity 2.0
   * Checks state.vscdb (SQLite), app_storage.json, and standalone session files.
   */
  static detectActiveAccount() {
    // 1. Try Antigravity IDE state.vscdb (SQLite)
    const dbPaths = AppPaths.getAntigravityStateDbCandidates();
    for (const dbPath of dbPaths) {
      if (fs.existsSync(dbPath)) {
        try {
          const db = new DatabaseSync(dbPath, { readOnly: true });
          try {
            const row = db
              .prepare("SELECT value FROM ItemTable WHERE key = 'antigravityAuthStatus'")
              .get();
            if (row && row.value) {
              const parsed = JSON.parse(row.value);
              if (parsed.email) {
                return {
                  email: parsed.email,
                  name: parsed.name || parsed.email,
                  source: 'state.vscdb (ItemTable: antigravityAuthStatus)',
                  path: dbPath,
                };
              }
            }
          } finally {
            db.close();
          }
        } catch {
          // If locked or read error, continue to next candidate
        }
      }
    }

    // 2. Try app_storage.json (used by Antigravity desktop on Linux/Windows)
    const storagePaths = AppPaths.getAntigravityAppStorageCandidates();
    for (const storagePath of storagePaths) {
      if (fs.existsSync(storagePath)) {
        try {
          const content = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
          const email =
            content['jetski.onboarding.lastLoginUsername'] ||
            content['antigravity.lastLoginUsername'];
          if (email && typeof email === 'string' && email.includes('@')) {
            return {
              email: email.trim(),
              source: 'app_storage.json (lastLoginUsername)',
              path: storagePath,
            };
          }
        } catch {}
      }
    }

    // 3. Try standalone jetski OAuth file
    const standalonePath = AppPaths.getStandaloneOAuthTokenPath();
    if (fs.existsSync(standalonePath)) {
      try {
        const content = JSON.parse(fs.readFileSync(standalonePath, 'utf8'));
        const email = content.email || content.token?.email;
        if (email) {
          return {
            email: email.trim(),
            source: 'jetski-standalone-oauth-token',
            path: standalonePath,
          };
        }
      } catch {}
    }

    return null;
  }
}
