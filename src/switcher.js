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
      (a) => a.id !== currentAccountId && a.status !== 'error',
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

    if (avgQuota <= 5) {
      return null; // All candidates are depleted
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

    // 3. Write standalone session file
    try {
      const standalonePath = AppPaths.getStandaloneOAuthTokenPath();
      const parentDir = path.dirname(standalonePath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      const tokenPayload = JSON.stringify({
        token: {
          access_token: account.accessToken,
          token_type: 'Bearer',
          refresh_token: account.refreshToken,
          expiry: new Date(account.expiresAt || Date.now() + 3600000).toISOString(),
        },
        auth_method: 'consumer',
        email: account.email,
      });
      fs.writeFileSync(standalonePath, tokenPayload, { mode: 0o600 });
      console.log(`[AccountSwitcher] Updated ${standalonePath}`);
    } catch {}
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

    // 2. Check if a conversation is actively running BEFORE restarting language_server
    const activeChat = ChatResumer.findActiveConversation();
    if (activeChat) {
      console.log(
        `[AccountSwitcher] Detected running chat: ${activeChat.title} (${activeChat.conversationId})`,
      );
    }

    // 3. Write credentials to Antigravity
    this.writeAccountToAntigravity(freshAccount);

    // 4. Mark active in local storage
    AccountsStore.setActiveAccount(freshAccount.id);

    // 5. Hot-restart language_server
    console.log('[AccountSwitcher] Hot-reloading Antigravity AI language server...');
    ProcessHelper.killLanguageServer();

    // 6. Wait 2 seconds for Antigravity supervisor to respawn language_server
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log('[AccountSwitcher] Language server reloaded with fresh credentials!');

    // 7. Re-continue interrupted chat if one was active
    let resumedChatId = null;
    if (activeChat?.conversationId) {
      console.log(`[AccountSwitcher] Resuming interrupted chat turn...`);
      const resumed = await ChatResumer.resumeChat(activeChat.conversationId);
      if (resumed) {
        resumedChatId = activeChat.conversationId;
      }
    }

    // 8. Refresh and check new account quota
    let newQuota = null;
    try {
      newQuota = await QuotaChecker.checkAccount(freshAccount);
    } catch {}

    // 9. Dispatch Bot Notification
    await BotNotifier.notifyAccountSwitched({
      oldEmail,
      newEmail: freshAccount.email,
      reason,
      resumedChatId,
      newQuota,
    });

    console.log(`[AccountSwitcher] Switch operation complete!\n`);
    return freshAccount;
  }
}
