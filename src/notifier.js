import os from 'node:os';
import { ConfigManager } from './config.js';

export class BotNotifier {
  /**
   * Dispatches a Telegram notification when an account is switched
   */
  static async notifyAccountSwitched({
    oldEmail,
    newEmail,
    reason,
    resumedChatId,
    resumedChats,
    newQuota,
  }) {
    const config = ConfigManager.load();
    const token = config.telegramBotToken?.trim();
    const chatId = config.telegramChatId?.trim();
    const deviceName = config.deviceName?.trim() || `${os.hostname()} (${os.platform()})`;

    const timestamp = new Date().toLocaleTimeString();
    const quotaInfo = newQuota
      ? `5h: ${newQuota.flash5h}% | 5d: ${newQuota.flash5d}%`
      : 'Healthy';

    let chatSummary = '<b>Active Chat:</b> None interrupted';
    if (resumedChats && Array.isArray(resumedChats) && resumedChats.length > 0) {
      chatSummary = [
        `<b>Resumed Active Chats (${resumedChats.length}):</b>`,
        ...resumedChats.map((c) => {
          const qCount = c.queuedMessages?.length || 0;
          const qText = qCount > 0 ? ` (queue: ${qCount} restored)` : '';
          return `  • <code>${c.title || c.conversationId}</code>${qText}`;
        }),
      ].join('\n');
    } else if (resumedChatId) {
      chatSummary = `<b>Interrupted Chat Resumed:</b> <code>${resumedChatId}</code>`;
    }

    const message = [
      `🔄 <b>Antigravity 2.0 Account Switched</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `<b>Device:</b> 💻 <code>${deviceName}</code>`,
      `<b>Old Account:</b> <code>${oldEmail || 'None'}</code>`,
      `<b>New Account:</b> <code>${newEmail}</code>`,
      `<b>New Account Quota:</b> ${quotaInfo}`,
      `<b>Reason:</b> ${reason || 'Flash 3.8 limit reached (<= 15%)'}`,
      `<b>IDE Status:</b> Language server hot-reloaded (IDE window preserved)`,
      chatSummary,
      `<b>Time:</b> ${timestamp}`,
    ].join('\n');

    console.log('\n[BotNotifier] Account Switch Notification:');
    console.log(message.replace(/<[^>]+>/g, '')); // Stripped HTML for console

    if (!token || !chatId) {
      console.log(
        '[BotNotifier] Telegram bot token or chat ID not set. Notification logged to console only.',
      );
      return false;
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      const data = await res.json();
      if (data.ok) {
        console.log('[BotNotifier] Telegram alert successfully sent!');
        return true;
      } else {
        console.warn('[BotNotifier] Telegram alert failed:', data.description);
        return false;
      }
    } catch (err) {
      console.error('[BotNotifier] Network error sending Telegram alert:', err.message);
      return false;
    }
  }

  /**
   * Dispatches a test Telegram alert using provided or saved credentials
   */
  static async sendTestAlert(customToken, customChatId) {
    const config = ConfigManager.load();
    const token = (customToken || config.telegramBotToken)?.trim();
    const chatId = (customChatId || config.telegramChatId)?.trim();

    if (!token) {
      return { ok: false, error: 'Telegram Bot Token is empty. Please enter your bot token.' };
    }
    if (!chatId) {
      return { ok: false, error: 'Telegram Chat ID is empty. Please enter your chat ID.' };
    }

    const timestamp = new Date().toLocaleTimeString();
    const deviceName = config.deviceName?.trim() || `${os.hostname()} (${os.platform()})`;
    const message = [
      `🔔 <b>Antigravity Light Test Notification</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `Your Telegram bot integration is working properly!`,
      `• <b>Device:</b> 💻 <code>${deviceName}</code>`,
      `• <b>Time:</b> ${timestamp}`,
      `• <b>Status:</b> Ready for auto-switch alerts`,
    ].join('\n');

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      const data = await res.json();
      if (data.ok) {
        console.log('[BotNotifier] Test Telegram notification sent successfully!');
        return { ok: true };
      } else {
        console.warn('[BotNotifier] Test Telegram alert failed:', data.description);
        return { ok: false, error: data.description || 'Telegram API returned an error' };
      }
    } catch (err) {
      console.error('[BotNotifier] Network error sending test alert:', err.message);
      return { ok: false, error: err.message };
    }
  }
}
