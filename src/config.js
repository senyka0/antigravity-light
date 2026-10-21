import fs from 'node:fs';
import { AppPaths } from './paths.js';

const DEFAULT_CONFIG = {
  proxyPort: 8080,
  proxyHost: '127.0.0.1',
  autoSwitchEnabled: true,
  depletionThresholdPercent: 15, // Switch if limit <= 15% (defensive safety ceiling)
  checkIntervalSeconds: 60,
  telegramBotToken: '',
  telegramChatId: '',
  deviceName: '',
  targetModel: 'gemini-3.8-flash',
  requestJitterEnabled: true,
  minJitterMs: 800,
  maxJitterMs: 1800,
};

export class ConfigManager {
  static load() {
    const configPath = AppPaths.getConfigFilePath();
    if (!fs.existsSync(configPath)) {
      this.save(DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG };
    }
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...DEFAULT_CONFIG, ...data };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  static save(config) {
    const configPath = AppPaths.getConfigFilePath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
      mode: 0o600,
    });
  }

  static update(partial) {
    const current = this.load();
    const updated = { ...current, ...partial };
    this.save(updated);
    return updated;
  }
}
