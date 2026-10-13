import http from 'node:http';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { exec } from 'node:child_process';
import { AccountsStore } from './storage.js';

export const OAUTH_CONFIG = {
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  clientSecret: 'YOUR_GOOGLE_CLIENT_SECRET',
  scopes: [
    'openid',
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
    'https://www.googleapis.com/auth/aicode',
  ].join(' '),
};

function openBrowser(url) {
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}" 2>/dev/null`, () => {});
  }
}

export class AuthService {
  static getAuthUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_id: OAUTH_CONFIG.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: OAUTH_CONFIG.scopes,
      access_type: 'offline',
      prompt: 'consent',
      state: state || randomUUID(),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  static async exchangeCode(code, redirectUri) {
    const params = new URLSearchParams({
      client_id: OAUTH_CONFIG.clientId,
      client_secret: OAUTH_CONFIG.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Token exchange failed (HTTP ${res.status}): ${err}`);
    }

    return await res.json();
  }

  static async refreshAccessToken(account) {
    if (!account.refreshToken) {
      throw new Error(`Account ${account.email} has no refresh token`);
    }

    const params = new URLSearchParams({
      client_id: OAUTH_CONFIG.clientId,
      client_secret: OAUTH_CONFIG.clientSecret,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Token refresh failed (HTTP ${res.status}): ${err}`);
    }

    const data = await res.json();
    const updated = AccountsStore.updateToken(account.id, {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      refreshToken: data.refresh_token || account.refreshToken,
      idToken: data.id_token || account.idToken,
    });

    return updated;
  }

  static async getUserInfo(accessToken) {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch user info: HTTP ${res.status}`);
    }
    return await res.json();
  }

  static async ensureValidToken(account) {
    // Refresh if within 2 minutes of expiration
    if (!account.expiresAt || account.expiresAt < Date.now() + 120_000) {
      return await this.refreshAccessToken(account);
    }
    return account;
  }

  /**
   * Interactive login with local loopback listener
   */
  static async startInteractiveLogin() {
    return new Promise((resolve, reject) => {
      const state = randomUUID();
      let redirectUri = '';
      let isDone = false;

      let rl = null;
      if (process.stdin.isTTY) {
        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
      }

      const finish = (result, isError = false) => {
        if (isDone) return;
        isDone = true;
        if (rl) {
          rl.close();
        }
        try {
          server.close();
        } catch {}
        if (isError) {
          reject(result);
        } else {
          resolve(result);
        }
      };

      const handleCode = async (code) => {
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
            idToken: tokenData.id_token,
            status: 'active',
            isActive: AccountsStore.getAccounts().length === 0,
          });

          finish(account);
        } catch (err) {
          finish(err, true);
        }
      };

      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url, `http://127.0.0.1`);
          if (reqUrl.pathname !== '/oauth-callback') {
            res.writeHead(404).end('Not Found');
            return;
          }

          const callbackState = reqUrl.searchParams.get('state');
          if (callbackState !== state) {
            res.writeHead(400).end('State verification mismatch');
            return;
          }

          const code = reqUrl.searchParams.get('code');
          if (!code) {
            res.writeHead(400).end('Missing authorization code');
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html>
<html>
<body style="font-family:sans-serif;text-align:center;padding:50px">
  <h2 style="color:#0f9d58">✓ Login Successful!</h2>
  <p>You can close this tab and return to the terminal.</p>
  <script>setTimeout(() => window.close(), 2500);</script>
</body>
</html>`);

          await handleCode(code);
        } catch (err) {
          finish(err, true);
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        redirectUri = `http://127.0.0.1:${port}/oauth-callback`;
        const authUrl = AuthService.getAuthUrl(redirectUri, state);

        console.log('\n============================================================');
        console.log('Opening browser for Google Authentication...');
        console.log('If browser does not open automatically, visit this URL:');
        console.log(authUrl);
        console.log('============================================================');
        console.log('Waiting for browser callback...');
        if (rl) {
          console.log('(Or paste authorization code or redirected callback URL here:)\n');
          rl.question('> ', async (answer) => {
            if (isDone || !answer) return;
            const input = answer.trim();
            let code = input;
            if (input.includes('code=')) {
              try {
                const parsedUrl = new URL(input);
                code = parsedUrl.searchParams.get('code') || input;
              } catch {
                const match = input.match(/[?&]code=([^&]+)/);
                if (match) code = decodeURIComponent(match[1]);
              }
            }
            console.log('\nProcessing authorization code...');
            await handleCode(code);
          });
        }

        openBrowser(authUrl);
      });

      server.on('error', (err) => finish(err, true));
    });
  }
}
