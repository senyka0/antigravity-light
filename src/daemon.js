import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { AppPaths } from './paths.js';
import { ConfigManager } from './config.js';
import { AccountsStore } from './storage.js';
import { QuotaChecker } from './quota.js';
import { AccountDetector } from './detector.js';
import { AccountSwitcher } from './switcher.js';
import { ProxyServer } from './proxy.js';
import { KeyringManager } from './keyring.js';

export class MonitorDaemon {
  static timer = null;
  static isRunning = false;
  static isChecking = false;

  static async runCheckCycle() {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      const config = ConfigManager.load();
      if (!config.autoSwitchEnabled) {
        return;
      }

      const threshold = config.depletionThresholdPercent ?? 5;

      // 1. Detect currently active account in Antigravity
      const detected = AccountDetector.detectActiveAccount();
      if (!detected?.email) {
        console.log('[Daemon] No active Antigravity account detected.');
      } else {
        console.log(`[Daemon] Active Antigravity account: ${detected.email} (${detected.source})`);
      }

      // 2. Find matching account in our registered pool or auto-enroll from Keyring
      let account = detected?.email ? AccountsStore.getAccountByEmail(detected.email) : null;
      if (!account && detected?.email) {
        try {
          const keyringCreds = KeyringManager.getCredentials();
          let keyringEmail = keyringCreds?.email;
          let keyringName = keyringCreds?.name;
          let keyringPicture = null;

          if (keyringCreds?.id_token) {
            try {
              const parts = keyringCreds.id_token.split('.');
              if (parts.length === 3) {
                const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
                keyringEmail = keyringEmail || decoded.email;
                keyringName = keyringName || decoded.name;
                keyringPicture = decoded.picture;
              }
            } catch {}
          }

          if (
            keyringEmail &&
            keyringEmail.toLowerCase() === detected.email.toLowerCase() &&
            keyringCreds?.token?.access_token
          ) {
            console.log(`[Daemon] Auto-importing detected active account from OS Keyring: ${detected.email}`);
            const expiresAt = keyringCreds.token.expiry
              ? new Date(keyringCreds.token.expiry).getTime()
              : Date.now() + 3600 * 1000;

            account = AccountsStore.upsertAccount({
              id: randomUUID(),
              email: detected.email,
              name: keyringName || detected.email,
              avatarUrl: keyringPicture || null,
              accessToken: keyringCreds.token.access_token,
              refreshToken: keyringCreds.token.refresh_token || '',
              expiresAt,
              status: 'active',
              isActive: true,
            });
            console.log(`[Daemon] Successfully enrolled ${account.email} into accounts pool.`);
          }
        } catch (importErr) {
          console.warn('[Daemon] Failed to auto-import keyring account:', importErr.message);
        }
      }

      // If still not found, fallback to active account in AccountsStore or first registered account
      if (!account) {
        account = AccountsStore.getActiveAccount() || AccountsStore.getAccounts()[0];
        if (!account) {
          console.log(
            `[Daemon] No registered accounts found in pool. Add an account via web dashboard or CLI.`,
          );
          return;
        }
        console.log(
          `[Daemon] Using registered pool account: ${account.email} (detected: ${detected?.email || 'none'})`,
        );
      }

      // 3. Check live quota for Flash 3.8 High (5h and 5d limits)
      const quota = await QuotaChecker.checkAccount(account);
      console.log(
        `[Daemon] Quota [${account.email}]: Flash 3.8 (5-Hour: ${quota.flash5h}%, 5-Day: ${quota.flash5d}%)`,
      );

      // 4. Auto-Switch if 5h or 5d limit is <= threshold or account is suspended
      if (quota.isDepleted || account.status === 'suspended') {
        const reason =
          quota.depletionReason ||
          (account.status === 'suspended' ? 'Account suspended (HTTP 403)' : 'Quota limit reached');
        console.warn(
          `\n⚠️ [Daemon] Quota depletion/suspension detected for ${account.email}: ${reason}`,
        );

        const nextAccount = await AccountSwitcher.findBestAccount(account.id);
        if (nextAccount) {
          console.log(`[Daemon] Found healthy candidate: ${nextAccount.email}`);
          await AccountSwitcher.performSwitch(nextAccount, reason);
        } else {
          console.warn(
            `[Daemon] No healthy alternative accounts available in pool! Please add more accounts.`,
          );
        }
      }

      // 5. Also refresh any inactive accounts whose reset time has elapsed or that are stale (>5m)
      const allAccounts = AccountsStore.getAccounts();
      const now = Date.now();
      for (const otherAcc of allAccounts) {
        if (otherAcc.id === account.id) continue;
        const reset5hPassed = otherAcc.quota?.resetTime5h && now >= new Date(otherAcc.quota.resetTime5h).getTime();
        const reset5dPassed = otherAcc.quota?.resetTime5d && now >= new Date(otherAcc.quota.resetTime5d).getTime();
        const stale = !otherAcc.quota?.lastChecked || (now - otherAcc.quota.lastChecked) > 300000;

        if (reset5hPassed || reset5dPassed || stale) {
          try {
            await QuotaChecker.checkAccount(otherAcc);
          } catch {}
        }
      }
    } catch (err) {
      console.error('[Daemon] Error in check cycle:', err.message);
    } finally {
      this.isChecking = false;
    }
  }

  static start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Track PID for cross-platform stop
    try {
      const pidFile = path.join(AppPaths.getLightAppDir(), 'daemon.pid');
      fs.writeFileSync(pidFile, String(process.pid));
      const cleanPid = () => {
        try {
          if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) {
            fs.unlinkSync(pidFile);
          }
        } catch {}
      };
      process.on('exit', cleanPid);
      process.on('SIGINT', () => { cleanPid(); process.exit(0); });
      process.on('SIGTERM', () => { cleanPid(); process.exit(0); });
    } catch {}

    const config = ConfigManager.load();

    console.log(`\n============================================================`);
    console.log(`Starting Antigravity Light Daemon`);
    console.log(`Check interval: every ${config.checkIntervalSeconds}s`);
    console.log(`Auto-switch threshold: Flash 3.8 remaining <= ${config.depletionThresholdPercent}%`);
    console.log(`============================================================\n`);

    // Start local proxy
    ProxyServer.start(config.proxyPort, config.proxyHost);

    // Initial check immediately
    this.runCheckCycle();

    // Periodic check loop
    this.timer = setInterval(() => {
      this.runCheckCycle();
    }, (config.checkIntervalSeconds || 60) * 1000);
  }

  static stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.log('[Daemon] Stopped.');
  }

  /**
   * Cross-platform method to stop a running background daemon process
   */
  static stopDaemonProcess() {
    const pidFile = path.join(AppPaths.getLightAppDir(), 'daemon.pid');
    if (!fs.existsSync(pidFile)) {
      console.log('No running daemon found (daemon.pid not present).');
      return false;
    }
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid) {
        if (process.platform === 'win32') {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGTERM');
        }
        try { fs.unlinkSync(pidFile); } catch {}
        console.log(`[Daemon] Stopped process PID ${pid}.`);
        return true;
      }
    } catch (err) {
      try { fs.unlinkSync(pidFile); } catch {}
      console.log(`Daemon process already stopped or could not terminate: ${err.message}`);
    }
    return false;
  }
}
