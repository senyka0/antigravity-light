import { ConfigManager } from './config.js';
import { AccountsStore } from './storage.js';
import { QuotaChecker } from './quota.js';
import { AccountDetector } from './detector.js';
import { AccountSwitcher } from './switcher.js';
import { ProxyServer } from './proxy.js';

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
        return;
      }

      console.log(`[Daemon] Active Antigravity account: ${detected.email} (${detected.source})`);

      // 2. Find matching account in our registered pool
      let account = AccountsStore.getAccountByEmail(detected.email);
      if (!account) {
        console.log(
          `[Daemon] Active account ${detected.email} is not in registered accounts pool. Add it via 'antigravity-light login'.`,
        );
        return;
      }

      // 3. Check live quota for Flash 3.8 High (5h and 5d limits)
      const quota = await QuotaChecker.checkAccount(account);
      console.log(
        `[Daemon] Quota [${account.email}]: Flash 3.8 (5-Hour: ${quota.flash5h}%, 5-Day: ${quota.flash5d}%)`,
      );

      // 4. Auto-Switch if 5h or 5d limit is <= threshold (5%)
      if (quota.isDepleted) {
        console.warn(
          `\n⚠️ [Daemon] Quota depletion detected for ${account.email}: ${quota.depletionReason}`,
        );

        const nextAccount = await AccountSwitcher.findBestAccount(account.id);
        if (nextAccount) {
          console.log(`[Daemon] Found healthy candidate: ${nextAccount.email}`);
          await AccountSwitcher.performSwitch(nextAccount, quota.depletionReason);
        } else {
          console.warn(
            `[Daemon] No healthy alternative accounts available in pool! Please add more accounts.`,
          );
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
}
