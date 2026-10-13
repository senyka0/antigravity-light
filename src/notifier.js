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
    newQuota,
  }) {
    const config = ConfigManager.load();
    const token = config.telegramBotToken?.trim();
    const chatId = config.telegramChatId?.trim();

    const timestamp = new Date().toLocaleTimeString();
    const quotaInfo = newQuota
      ? `5h: ${newQuota.flash5h}% | 5d: ${newQuota.flash5d}%`
      : 'Healthy';

    const message = [
      `🔄 <b>Antigravity 2.0 Account Switched</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `<b>Old Account:</b> <code>${oldEmail || 'None'}</code>`,
      `<b>New Account:</b> <code>${newEmail}</code>`,
      `<b>New Account Quota:</b> ${quotaInfo}`,
      `<b>Reason:</b> ${reason || 'Flash 3.8 limit reached (<= 5%)'}`,
      `<b>IDE Status:</b> Language server hot-reloaded (IDE window preserved)`,
      resumedChatId
        ? `<b>Interrupted Chat Resumed:</b> <code>${resumedChatId}</code>`
        : `<b>Active Chat:</b> None interrupted`,
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
}
