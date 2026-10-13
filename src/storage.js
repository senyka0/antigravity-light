import fs from 'node:fs';
import { AppPaths } from './paths.js';

export class AccountsStore {
  static load() {
    const filePath = AppPaths.getAccountsFilePath();
    if (!fs.existsSync(filePath)) {
      this.save([]);
      return [];
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return [];
    }
  }

  static save(accounts) {
    const filePath = AppPaths.getAccountsFilePath();
    fs.writeFileSync(filePath, JSON.stringify(accounts, null, 2), {
      mode: 0o600,
    });
  }

  static getAccounts() {
    return this.load();
  }

  static getAccount(id) {
    return this.getAccounts().find((a) => a.id === id) || null;
  }

  static getAccountByEmail(email) {
    return (
      this.getAccounts().find(
        (a) => a.email.toLowerCase() === email.toLowerCase(),
      ) || null
    );
  }

  static getActiveAccount() {
    const accounts = this.getAccounts();
    return accounts.find((a) => a.isActive) || accounts[0] || null;
  }

  static setActiveAccount(id) {
    const accounts = this.getAccounts();
    for (const acc of accounts) {
      acc.isActive = acc.id === id;
    }
    this.save(accounts);
    return this.getAccount(id);
  }

  static upsertAccount(account) {
    const accounts = this.getAccounts();
    const existingIndex = accounts.findIndex(
      (a) => a.id === account.id || a.email.toLowerCase() === account.email.toLowerCase(),
    );

    if (existingIndex >= 0) {
      accounts[existingIndex] = {
        ...accounts[existingIndex],
        ...account,
      };
    } else {
      if (accounts.length === 0) {
        account.isActive = true;
      }
      accounts.push(account);
    }

    this.save(accounts);
    return account;
  }

  static updateToken(id, { accessToken, expiresAt, refreshToken }) {
    const accounts = this.getAccounts();
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return null;

    acc.accessToken = accessToken;
    acc.expiresAt = expiresAt;
    if (refreshToken) {
      acc.refreshToken = refreshToken;
    }
    this.save(accounts);
    return acc;
  }

  static updateQuota(id, quota) {
    const accounts = this.getAccounts();
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return null;

    acc.quota = quota;
    this.save(accounts);
    return acc;
  }

  static removeAccount(id) {
    const accounts = this.getAccounts().filter((a) => a.id !== id && a.email !== id);
    this.save(accounts);
  }
}
