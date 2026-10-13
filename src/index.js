#!/usr/bin/env node

import { AuthService } from './auth.js';
import { AccountsStore } from './storage.js';
import { QuotaChecker } from './quota.js';
import { AccountDetector } from './detector.js';
import { AccountSwitcher } from './switcher.js';
import { ConfigManager } from './config.js';
import { MonitorDaemon } from './daemon.js';
import { ProxyServer } from './proxy.js';
import { randomUUID } from 'node:crypto';

import { exec } from 'node:child_process';

function openBrowser(url) {
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}" 2>/dev/null`, () => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command) {
    case 'start': {
      MonitorDaemon.start();
      break;
    }

    case 'ui': {
      const config = ConfigManager.load();
      MonitorDaemon.start();
      const uiUrl = `http://${config.proxyHost || '127.0.0.1'}:${config.proxyPort || 8080}`;
      console.log(`\nOpening Web Dashboard in your browser: ${uiUrl}`);
      openBrowser(uiUrl);
      break;
    }

    case 'proxy': {
      const config = ConfigManager.load();
      ProxyServer.start(config.proxyPort, config.proxyHost);
      break;
    }

    case 'login': {
      console.log('Initiating Google OAuth login...');
      try {
        const account = await AuthService.startInteractiveLogin();
        console.log(`\n✓ Successfully added account: ${account.email}`);
        
        console.log('Fetching initial quota...');
        const quota = await QuotaChecker.checkAccount(account);
        console.log(`Flash 3.8 Quota: 5-Hour: ${quota.flash5h}%, 5-Day: ${quota.flash5d}%`);
      } catch (err) {
        console.error('Login failed:', err.message);
      }
      break;
    }

    case 'add-token': {
      const [refreshToken, email] = [args[1], args[2]];
      if (!refreshToken || !email) {
        console.error('Usage: antigravity-light add-token <refresh_token> <email>');
        process.exit(1);
      }
      try {
        const account = AccountsStore.upsertAccount({
          id: randomUUID(),
          email: email.trim(),
          refreshToken: refreshToken.trim(),
          accessToken: '',
          expiresAt: 0,
          status: 'active',
          isActive: AccountsStore.getAccounts().length === 0,
        });
        console.log(`Added account: ${account.email}. Refreshing token...`);
        const refreshed = await AuthService.refreshAccessToken(account);
        const quota = await QuotaChecker.checkAccount(refreshed);
        console.log(`✓ Account ready! Flash 3.8: 5h: ${quota.flash5h}%, 5d: ${quota.flash5d}%`);
      } catch (err) {
        console.error('Failed to add account via token:', err.message);
      }
      break;
    }

    case 'accounts': {
      const accounts = AccountsStore.getAccounts();
      const detected = AccountDetector.detectActiveAccount();

      console.log('\n--- Registered Accounts ---');
      if (accounts.length === 0) {
        console.log('No accounts registered yet. Run: antigravity-light login');
      } else {
        for (const a of accounts) {
          const isCurrentInIde = detected?.email?.toLowerCase() === a.email.toLowerCase();
          const marker = a.isActive ? '[Active in App]' : '               ';
          const ideMarker = isCurrentInIde ? '[Used in IDE]' : '';
          const q5h = a.quota?.flash5h !== undefined ? `${a.quota.flash5h}%` : 'unknown';
          const q5d = a.quota?.flash5d !== undefined ? `${a.quota.flash5d}%` : 'unknown';

          console.log(`${marker} ${ideMarker} ${a.email}`);
          console.log(`   └─ Flash 3.8 Limits -> 5-Hour: ${q5h} | 5-Day: ${q5d}`);
        }
      }
      console.log('');
      break;
    }

    case 'active': {
      const detected = AccountDetector.detectActiveAccount();
      console.log('\n--- Antigravity 2.0 Active Account ---');
      if (detected) {
        console.log(`Email:  ${detected.email}`);
        console.log(`Source: ${detected.source}`);
        console.log(`Path:   ${detected.path}`);
      } else {
        console.log('No active Antigravity account found on this machine.');
      }
      console.log('');
      break;
    }

    case 'check': {
      const accounts = AccountsStore.getAccounts();
      if (accounts.length === 0) {
        console.log('No accounts to check.');
        return;
      }
      console.log(`\nChecking quota for ${accounts.length} accounts...`);
      for (const a of accounts) {
        try {
          const q = await QuotaChecker.checkAccount(a);
          console.log(`✓ ${a.email}: Flash 3.8 -> 5h: ${q.flash5h}%, 5d: ${q.flash5d}% (Depleted: ${q.isDepleted})`);
        } catch (err) {
          console.error(`✗ ${a.email}: ${err.message}`);
        }
      }
      console.log('');
      break;
    }

    case 'switch': {
      const targetEmail = args[1];
      if (!targetEmail) {
        console.error('Usage: antigravity-light switch <email>');
        process.exit(1);
      }
      const acc = AccountsStore.getAccountByEmail(targetEmail);
      if (!acc) {
        console.error(`Account not found: ${targetEmail}`);
        process.exit(1);
      }
      await AccountSwitcher.performSwitch(acc, 'Manual CLI switch command');
      break;
    }

    case 'config': {
      const key = args[1];
      const val = args[2];
      if (!key) {
        console.log('\nCurrent Config:', ConfigManager.load());
        return;
      }
      if (val === undefined) {
        console.log(`${key}:`, ConfigManager.load()[key]);
        return;
      }

      let parsedVal = val;
      if (val === 'true') parsedVal = true;
      if (val === 'false') parsedVal = false;
      if (!isNaN(Number(val))) parsedVal = Number(val);

      const updated = ConfigManager.update({ [key]: parsedVal });
      console.log(`Updated ${key} =`, updated[key]);
      break;
    }

    case 'help':
    default: {
      console.log(`
Antigravity Light - Custom Account Manager & Local OpenAI Proxy
================================================================
Commands:
  start                     Start background monitor (auto-switch & quota watcher) + local proxy
  ui                        Start background monitor & open the Web Dashboard in Chrome
  proxy                     Start only the local OpenAI-compatible API proxy (:8080)
  login                     Add a Google account via interactive browser OAuth
  add-token <token> <email> Add account manually with refresh token
  accounts                  List registered accounts and their 5h & 5d Flash 3.8 limits
  active                    Show currently active account in Antigravity 2.0 app
  check                     Check live limits for all registered accounts now
  switch <email>            Manually switch active Antigravity account & reload language server
  config [key] [val]        View or update configuration (e.g. telegramBotToken, telegramChatId)
  help                      Show this help message

Web Dashboard:
  Open in Chrome:  http://127.0.0.1:8080

Local OpenAI Endpoint:
  Base URL:        http://127.0.0.1:8080/v1
  Models:          gemini-3.8-flash, gemini-3.1-pro, claude-3-7-sonnet
`);
      break;
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
