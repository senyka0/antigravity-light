import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import { AppPaths, isWindows } from './paths.js';
import { AccountsStore } from './storage.js';
import { AuthService } from './auth.js';
import { QuotaChecker } from './quota.js';
import { ChatResumer } from './chat-resumer.js';
import { BotNotifier } from './notifier.js';
import { AccountDetector } from './detector.js';
import { KeyringManager } from './keyring.js';
import { ConfigManager } from './config.js';
import { ElectronShellManager } from './electron-shell.js';

export class ProcessHelper {
  static killLanguageServer() {
    try {
      if (isWindows) {
        execSync('taskkill /F /IM language_server.exe', { stdio: 'ignore' });
      } else {
        execSync('pkill -9 -f language_server', { stdio: 'ignore' });
      }
      return true;
    } catch {
      return false; // Not running
    }
  }
}

export class AccountSwitcher {
  /**
   * Finds the best alternative account with quota > threshold
   */
  static async findBestAccount(currentAccountId) {
    const accounts = AccountsStore.getAccounts();
    const candidates = accounts.filter(
      (a) =>
        a.id !== currentAccountId &&
        a.status !== 'error' &&
        a.status !== 'suspended' &&
        !a.quota?.isDepleted,
    );

    if (candidates.length === 0) {
      return null;
    }

    // Sort by highest available quota (average of 5h and 5d)
    candidates.sort((a, b) => {
      const quotaA = ((a.quota?.flash5h ?? 100) + (a.quota?.flash5d ?? 100)) / 2;
      const quotaB = ((b.quota?.flash5h ?? 100) + (b.quota?.flash5d ?? 100)) / 2;
      return quotaB - quotaA;
    });

    const best = candidates[0];
    const avgQuota = ((best.quota?.flash5h ?? 100) + (best.quota?.flash5d ?? 100)) / 2;

    const config = ConfigManager.load();
    const threshold = config.depletionThresholdPercent ?? 15;

    if (avgQuota <= threshold) {
      return null; // All candidates are depleted below safety ceiling
    }

    return best;
  }

  /**
   * Writes the account credentials into Antigravity storage
   */
  static writeAccountToAntigravity(account) {
    // 1. Update state.vscdb if available
    const dbPaths = AppPaths.getAntigravityStateDbCandidates();
    for (const dbPath of dbPaths) {
      if (fs.existsSync(dbPath)) {
        try {
          const db = new DatabaseSync(dbPath);
          try {
            const authStatusJson = JSON.stringify({
              name: account.name || account.email,
              email: account.email,
              apiKey: account.accessToken,
            });

            db.prepare(
              `INSERT INTO ItemTable (key, value) VALUES ('antigravityAuthStatus', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run(authStatusJson);

            db.prepare(
              `INSERT INTO ItemTable (key, value) VALUES ('antigravityOnboarding', 'true')
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run();

            console.log(`[AccountSwitcher] Updated credentials in ${dbPath}`);
          } finally {
            db.close();
          }
        } catch (err) {
          console.warn(`[AccountSwitcher] Failed to write to ${dbPath}:`, err.message);
        }
      }
    }

    // 2. Update app_storage.json if available
    const storagePaths = AppPaths.getAntigravityAppStorageCandidates();
    for (const storagePath of storagePaths) {
      if (fs.existsSync(storagePath)) {
        try {
          const content = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
          content['jetski.onboarding.lastLoginUsername'] = account.email;
          content['antigravity.lastLoginUsername'] = account.email;
          fs.writeFileSync(storagePath, JSON.stringify(content, null, 2), 'utf8');
          console.log(`[AccountSwitcher] Updated email in ${storagePath}`);
        } catch (err) {
          console.warn(`[AccountSwitcher] Failed to write to ${storagePath}:`, err.message);
        }
      }
    }

    // 3. Update OS Keyring (GNOME Keyring via DBus / Windows Credential Manager) and standalone session file
    try {
      KeyringManager.setCredentials(account);
      console.log(`[AccountSwitcher] Updated OS Keyring (gemini/antigravity) for ${account.email}`);
    } catch (err) {
      console.warn(`[AccountSwitcher] Failed to write OS Keyring: ${err.message}`);
    }
  }

  /**
   * Performs the full auto-switch lifecycle
   */
  static async performSwitch(targetAccount, reason = 'Quota threshold reached') {
    const currentDetected = AccountDetector.detectActiveAccount();
    const oldEmail = currentDetected?.email;

    console.log(`\n============================================================`);
    console.log(`[AccountSwitcher] Initiating switch to: ${targetAccount.email}`);
    console.log(`[AccountSwitcher] Reason: ${reason}`);
    console.log(`============================================================`);

    // 1. Ensure target account has a fresh token
    const freshAccount = await AuthService.ensureValidToken(targetAccount);

    // 2. Snapshot ALL running conversations & queued messages BEFORE restarting language_server
    const chatSnapshot = await ChatResumer.snapshotAllRunningChats();
    const runningCount = chatSnapshot.runningChats.length;
    if (runningCount > 0) {
      console.log(`[AccountSwitcher] Detected ${runningCount} in-flight active chat(s) before switch:`);
      for (const chat of chatSnapshot.runningChats) {
        console.log(`  - "${chat.title}" (${chat.conversationId}) | Queued: ${chat.queuedMessages?.length || 0}`);
      }
    } else {
      console.log('[AccountSwitcher] All conversations are idle before switch.');
    }

    // 3. Write credentials to Antigravity (OS Keyring + app_storage + standalone)
    this.writeAccountToAntigravity(freshAccount);

    // 4. Sync Electron Desktop Shell in-memory storage manager
    await ElectronShellManager.syncAccount(freshAccount);

    // 5. Mark active in local storage
    AccountsStore.setActiveAccount(freshAccount.id);

    // 6. Hot-restart language_server
    console.log('[AccountSwitcher] Hot-reloading Antigravity AI language server...');
    ProcessHelper.killLanguageServer();

    // 7. Wait 4 seconds for Antigravity supervisor to respawn language_server and reload windows
    await new Promise((resolve) => setTimeout(resolve, 4000));
    console.log('[AccountSwitcher] Language server reloaded with fresh credentials!');

    // 8. Ensure Electron shell in-memory storage manager is synced after reload
    await ElectronShellManager.syncAccount(freshAccount);

    // 9. Resume ALL interrupted conversations and restore their queued messages
    let resumedResults = [];
    if (runningCount > 0) {
      console.log('[AccountSwitcher] Resuming all active conversations and restoring queued messages...');
      resumedResults = await ChatResumer.resumeAllActiveConversations(chatSnapshot);
    } else {
      console.log('[AccountSwitcher] Chat is idle. No automatic continuation needed.');
    }

    // 10. Refresh and check new account quota
    let newQuota = null;
    try {
      newQuota = await QuotaChecker.checkAccount(freshAccount);
    } catch {}

    // 11. Dispatch Bot Notification
    await BotNotifier.notifyAccountSwitched({
      oldEmail,
      newEmail: freshAccount.email,
      reason,
      resumedChatId: resumedResults[0]?.conversationId || null,
      resumedChats: resumedResults,
      newQuota,
    });

    console.log(`[AccountSwitcher] Switch operation complete!\n`);
    return freshAccount;
  }
}
