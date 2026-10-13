import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AccountsStore } from './storage.js';
import { AuthService } from './auth.js';
import { QuotaChecker } from './quota.js';
import { AppPaths } from './paths.js';
import { ConfigManager } from './config.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountDetector } from './detector.js';
import { ChatResumer } from './chat-resumer.js';
import { AccountSwitcher } from './switcher.js';
import { BotNotifier } from './notifier.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DASHBOARD_HTML_PATH = path.join(__dirname, 'dashboard.html');

export class ProxyServer {
  static start(port = 8080, host = '127.0.0.1') {
    const server = http.createServer(async (req, res) => {
      // CORS headers for browser-based apps
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');

      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      const url = new URL(req.url, `http://${host}:${port}`);

      try {
        // --- Web Dashboard UI ---
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
          if (fs.existsSync(DASHBOARD_HTML_PATH)) {
            const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
          }
        }

        // --- Dashboard REST API ---
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const accounts = AccountsStore.getAccounts();
          const activeIdeAccount = AccountDetector.detectActiveAccount();
          const activeChat = ChatResumer.findActiveConversation();
          const config = ConfigManager.load();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accounts, activeIdeAccount, activeChat, config }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/check') {
          const accounts = AccountsStore.getAccounts();
          await Promise.all(accounts.map((a) => QuotaChecker.checkAccount(a).catch(() => null)));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, accounts: AccountsStore.getAccounts() }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/switch') {
          const body = await this.readJsonBody(req);
          const acc = AccountsStore.getAccountByEmail(body.email);
          if (!acc) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Account not found' }));
            return;
          }
          await AccountSwitcher.performSwitch(acc, 'Manual Web Dashboard Switch');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, account: acc }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/config') {
          const body = await this.readJsonBody(req);
          const updated = ConfigManager.update(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, config: updated }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/accounts/delete') {
          const body = await this.readJsonBody(req);
          AccountsStore.removeAccount(body.id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/auth/url') {
          const redirectUri = `http://${host}:${port}/oauth-callback`;
          const authUrl = AuthService.getAuthUrl(redirectUri);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: authUrl }));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/oauth-callback') {
          const code = url.searchParams.get('code');
          if (code) {
            const redirectUri = `http://${host}:${port}/oauth-callback`;
            try {
              const tokenData = await AuthService.exchangeCode(code, redirectUri);
              const userInfo = await AuthService.getUserInfo(tokenData.access_token);
              const account = AccountsStore.upsertAccount({
                id: randomUUID(),
                email: userInfo.email,
                name: userInfo.name || userInfo.email,
                avatarUrl: userInfo.picture,
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
                status: 'active',
                isActive: AccountsStore.getAccounts().length === 0,
              });
              await QuotaChecker.checkAccount(account).catch(() => null);
              res.writeHead(302, { Location: '/' });
              res.end();
              return;
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(`<h2>Login failed</h2><p>${err.message}</p><a href="/">Return to Dashboard</a>`);
              return;
            }
          }
        }

        if (req.method === 'POST' && url.pathname === '/api/auth/code') {
          const body = await this.readJsonBody(req);
          let code = (body.code || '').trim();
          if (code.includes('code=')) {
            try {
              const parsed = new URL(code);
              code = parsed.searchParams.get('code') || code;
            } catch {
              const match = code.match(/[?&]code=([^&]+)/);
              if (match) code = decodeURIComponent(match[1]);
            }
          }
          const redirectUri = `http://${host}:${port}/oauth-callback`;
          const tokenData = await AuthService.exchangeCode(code, redirectUri);
          const userInfo = await AuthService.getUserInfo(tokenData.access_token);
          const account = AccountsStore.upsertAccount({
            id: randomUUID(),
            email: userInfo.email,
            name: userInfo.name || userInfo.email,
            avatarUrl: userInfo.picture,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
            status: 'active',
            isActive: AccountsStore.getAccounts().length === 0,
          });
          await QuotaChecker.checkAccount(account).catch(() => null);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, account }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/notify/test') {
          const ok = await BotNotifier.notifyAccountSwitched({
            oldEmail: 'current-account@gmail.com',
            newEmail: 'switch-candidate@gmail.com',
            reason: 'Test alert from Antigravity Light Dashboard',
            newQuota: { flash5h: 92, flash5d: 88 },
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
          return;
        }

        // --- OpenAI and Gemini Routes ---
        if (req.method === 'GET' && url.pathname === '/v1/models') {
          return this.handleModels(res);
        }

        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          const body = await this.readJsonBody(req);
          return await this.handleChatCompletions(body, res);
        }

        if (url.pathname.startsWith('/v1beta/models/')) {
          const body = await this.readJsonBody(req);
          return await this.handleNativeGemini(url.pathname, url.search, body, res);
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Not Found: ${url.pathname}`, type: 'invalid_request_error' } }));
      } catch (err) {
        console.error('[ProxyServer] Request error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
        }
      }
    });

    server.listen(port, host, () => {
      console.log(`[ProxyServer] Local OpenAI-compatible proxy running at http://${host}:${port}/v1`);
      console.log(`[ProxyServer] Connect Cursor, Continue, Cline, or Python with Base URL: http://${host}:${port}/v1`);
    });

    return server;
  }

  static readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          reject(new Error('Invalid JSON request body'));
        }
      });
      req.on('error', reject);
    });
  }

  static handleModels(res) {
    const models = [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.1-pro',
      'claude-3-7-sonnet',
      'gpt-4o',
    ];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: models.map((m) => ({
          id: m,
          object: 'model',
          created: 1700000000,
          owned_by: 'antigravity',
        })),
      }),
    );
  }

  /**
   * Translates OpenAI chat request to Gemini Cloud Code format
   */
  static convertToGeminiPayload(openAiBody, projectId) {
    const messages = openAiBody.messages || [];
    const systemMsg = messages.find((m) => m.role === 'system');
    const chatMsgs = messages.filter((m) => m.role !== 'system');

    let model = openAiBody.model || 'gemini-3.8-flash';
    // Map common aliases
    if (model === 'gpt-4o' || model === 'gpt-4' || model === 'claude-3-5-sonnet') {
      model = 'gemini-3.8-flash';
    }

    return {
      project: projectId || undefined,
      requestId: randomUUID(),
      model,
      userAgent: AppPaths.getUserAgent(),
      request: {
        ...(systemMsg
          ? { systemInstruction: { parts: [{ text: systemMsg.content }] } }
          : {}),
        contents: chatMsgs.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
        })),
        generationConfig: {
          temperature: openAiBody.temperature ?? 0.7,
          maxOutputTokens: openAiBody.max_tokens ?? openAiBody.max_completion_tokens ?? undefined,
        },
      },
    };
  }

  /**
   * Selects an eligible account with auto-rotation if current is exhausted
   */
  static async getEligibleAccount(excludedAccountIds = new Set()) {
    const accounts = AccountsStore.getAccounts();
    const active = AccountsStore.getActiveAccount();

    const pool = active ? [active, ...accounts.filter((a) => a.id !== active.id)] : accounts;
    const candidates = pool.filter((a) => !excludedAccountIds.has(a.id));

    if (candidates.length === 0) {
      throw new Error('All accounts are exhausted or unavailable');
    }

    const candidate = candidates[0];
    const freshAccount = await AuthService.ensureValidToken(candidate);

    if (!freshAccount.projectId) {
      freshAccount.projectId = await QuotaChecker.fetchProjectId(freshAccount.accessToken);
      if (freshAccount.projectId) {
        AccountsStore.upsertAccount(freshAccount);
      }
    }

    return freshAccount;
  }

  static async handleChatCompletions(openAiBody, res) {
    const isStream = Boolean(openAiBody.stream);
    const excludedIds = new Set();
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      let account;
      try {
        account = await this.getEligibleAccount(excludedIds);
      } catch (err) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message, type: 'insufficient_quota' } }));
        return;
      }

      const geminiPayload = this.convertToGeminiPayload(openAiBody, account.projectId);
      const endpoint = isStream
        ? 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'
        : 'https://cloudcode-pa.googleapis.com/v1internal:generateContent';

      const headers = {
        Authorization: `Bearer ${account.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': AppPaths.getUserAgent(),
      };

      try {
        const upstreamRes = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(geminiPayload),
        });

        // 401 Unauthorized -> Refresh token and retry
        if (upstreamRes.status === 401) {
          console.warn(`[ProxyServer] Token for ${account.email} was rejected (401). Refreshing...`);
          await AuthService.refreshAccessToken(account);
          continue;
        }

        // 429 Rate limited -> Rotate to next account
        if (upstreamRes.status === 429) {
          console.warn(`[ProxyServer] Account ${account.email} rate limited (429). Rotating to next account...`);
          excludedIds.add(account.id);
          continue;
        }

        if (!upstreamRes.ok) {
          const errText = await upstreamRes.text();
          throw new Error(`Upstream returned HTTP ${upstreamRes.status}: ${errText}`);
        }

        // Non-streaming response
        if (!isStream) {
          const json = await upstreamRes.json();
          const text = json?.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: `chatcmpl-${randomUUID()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: openAiBody.model || 'gemini-3.8-flash',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: text },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
          return;
        }

        // Streaming SSE response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const reader = upstreamRes.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6));
                const deltaText = parsed?.response?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (deltaText) {
                  const chunk = {
                    id: `chatcmpl-${randomUUID()}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: openAiBody.model || 'gemini-3.8-flash',
                    choices: [
                      {
                        index: 0,
                        delta: { content: deltaText },
                        finish_reason: null,
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
              } catch {}
            }
          }
        }

        res.write('data: [DONE]\n\n');
        res.end();
        return;
      } catch (err) {
        console.warn(`[ProxyServer] Attempt with ${account.email} failed:`, err.message);
        excludedIds.add(account.id);
      }
    }

    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'All upstream attempts failed', type: 'upstream_error' } }));
  }

  static async handleNativeGemini(pathname, search, body, res) {
    const account = await this.getEligibleAccount();
    const endpoint = `https://cloudcode-pa.googleapis.com${pathname}${search}`;

    const upstreamRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': AppPaths.getUserAgent(),
      },
      body: JSON.stringify(body),
    });

    res.writeHead(upstreamRes.status, {
      'Content-Type': upstreamRes.headers.get('content-type') || 'application/json',
    });

    const stream = upstreamRes.body;
    if (stream) {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      res.end();
    }
  }
}
