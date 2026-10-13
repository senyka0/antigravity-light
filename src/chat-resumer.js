import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppPaths } from './paths.js';

export class ChatResumer {
  /**
   * Checks if there is any conversation actively running or generating in Antigravity
   */
  static findActiveConversation() {
    // 1. Check conversation_summaries.db
    const dbPath = AppPaths.getConversationsDb();
    if (fs.existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const row = db
            .prepare(
              `SELECT conversation_id, title, status, not_fully_idle 
               FROM conversation_summaries 
               WHERE status = 'CASCADE_RUN_STATUS_RUNNING' OR not_fully_idle = 1 
               ORDER BY last_modified_time DESC 
               LIMIT 1`,
            )
            .get();

          if (row && row.conversation_id) {
            return {
              conversationId: row.conversation_id,
              title: row.title || 'Active Conversation',
              status: row.status,
            };
          }
        } finally {
          db.close();
        }
      } catch {}
    }

    // 2. Check presence lock files
    const presenceDir = AppPaths.getPresenceDir();
    if (fs.existsSync(presenceDir)) {
      try {
        const files = fs.readdirSync(presenceDir).filter((f) => f.endsWith('.lock'));
        if (files.length > 0) {
          const conversationId = path.basename(files[0], '.lock');
          return {
            conversationId,
            title: 'Active Conversation (Locked)',
            status: 'CASCADE_RUN_STATUS_RUNNING',
          };
        }
      } catch {}
    }

    // 3. Fallback: check most recently modified conversation
    if (fs.existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const row = db
            .prepare(
              `SELECT conversation_id, title, status 
               FROM conversation_summaries 
               ORDER BY last_modified_time DESC 
               LIMIT 1`,
            )
            .get();

          if (row && row.conversation_id) {
            return {
              conversationId: row.conversation_id,
              title: row.title || 'Recent Conversation',
              status: row.status,
            };
          }
        } finally {
          db.close();
        }
      } catch {}
    }

    return null;
  }

  /**
   * Evaluates prompt insertion and send in a specific CDP WebSocket page target
   */
  static evaluateUiResume(webSocketDebuggerUrl, conversationId, promptText) {
    return new Promise((resolve) => {
      let resolved = false;
      let ws;
      try {
        ws = new WebSocket(webSocketDebuggerUrl);
      } catch (e) {
        return resolve({ ok: false, reason: e.message });
      }

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { ws.close(); } catch {}
          resolve({ ok: false, reason: 'Timeout waiting for UI response' });
        }
      }, 8000);

      ws.onopen = () => {
        const expression = `
          (() => {
            // 1. If conversationId is specified and we're on a different conversation, switch via sidebar link
            const targetId = ${JSON.stringify(conversationId || '')};
            if (targetId && !window.location.href.includes(targetId)) {
              const link = document.querySelector('a[href*="' + targetId + '"]');
              if (link) {
                link.click();
                return JSON.stringify({ ok: false, status: "navigating_to_conversation" });
              }
            }

            // 2. Check if already actively generating
            const stopBtn = Array.from(document.querySelectorAll("button")).find(
              b => b.innerText && b.innerText.trim().toLowerCase().includes("stop execution")
            );
            if (stopBtn) {
              return JSON.stringify({ ok: true, status: "already_running" });
            }

            // 3. Look for an explicit Continue or Resume button
            const continueBtn = Array.from(document.querySelectorAll("button")).find(
              b => b.innerText && (b.innerText.trim().toLowerCase() === "continue" || b.innerText.trim().toLowerCase() === "resume")
            );
            if (continueBtn && !continueBtn.disabled) {
              continueBtn.click();
              return JSON.stringify({ ok: true, status: "clicked_continue_button" });
            }

            // 4. Target the Lexical input editor and send button
            const editor = document.querySelector("[contenteditable=\\"true\\"]");
            const sendBtn = document.querySelector("button[aria-label=\\"Send message\\"]");
            if (editor && sendBtn) {
              editor.focus();
              document.execCommand("selectAll", false, null);
              document.execCommand("insertText", false, ${JSON.stringify(promptText)});
              setTimeout(() => {
                const btn = document.querySelector("button[aria-label=\\"Send message\\"]");
                if (btn && !btn.disabled) {
                  btn.click();
                }
              }, 150);
              return JSON.stringify({ ok: true, status: "sent_prompt_in_ui", prompt: ${JSON.stringify(promptText)} });
            }

            return JSON.stringify({ ok: false, status: "editor_or_send_button_not_found" });
          })()
        `;

        ws.send(JSON.stringify({
          id: 100,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true },
        }));
      };

      ws.onmessage = (event) => {
        if (resolved) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.id === 100) {
            resolved = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            const val = msg.result?.result?.value;
            const parsedVal = typeof val === 'string' ? JSON.parse(val) : val;
            resolve(parsedVal || { ok: false, reason: 'Empty result from UI' });
          }
        } catch (err) {
          resolved = true;
          clearTimeout(timeout);
          try { ws.close(); } catch {}
          resolve({ ok: false, reason: err.message });
        }
      };

      ws.onerror = (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        try { ws.close(); } catch {}
        resolve({ ok: false, reason: err.message || 'WebSocket connection error' });
      };
    });
  }

  /**
   * Resumes conversation directly in Antigravity 2.0 UI via Chrome DevTools Protocol with retry polling
   */
  static async resumeInAntigravityUi(conversationId, promptText = 'continue', maxAttempts = 12, intervalMs = 1000) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const devToolsFile = AppPaths.getDevToolsPortFile();
      if (!devToolsFile || !fs.existsSync(devToolsFile)) {
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }

      let port;
      try {
        const content = fs.readFileSync(devToolsFile, 'utf8').trim().split('\n');
        port = parseInt(content[0], 10);
        if (!port || isNaN(port)) {
          await new Promise((r) => setTimeout(r, intervalMs));
          continue;
        }
      } catch {
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }

      let targets = [];
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json`);
        if (res.ok) {
          targets = await res.json();
        }
      } catch {}

      if (!Array.isArray(targets) || targets.length === 0) {
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }

      // Priority 1: Target specifically matching conversationId in url
      let target = null;
      if (conversationId) {
        target = targets.find((t) => t.url && t.url.includes(conversationId));
      }
      // Priority 2: Target with active conversation page (/c/)
      if (!target) {
        target = targets.find((t) => t.type === 'page' && t.url && t.url.includes('/c/'));
      }
      // Priority 3: Antigravity window
      if (!target) {
        target = targets.find((t) => t.type === 'page' && t.title && t.title.includes('Antigravity'));
      }
      if (!target && targets.length > 0) {
        target = targets.find((t) => t.type === 'page') || targets[0];
      }

      if (!target || !target.webSocketDebuggerUrl) {
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }

      const result = await this.evaluateUiResume(target.webSocketDebuggerUrl, conversationId, promptText);
      if (result && result.ok) {
        return result;
      }

      // If still navigating or waiting for editor to render after language server reload, retry
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, intervalMs));
      } else {
        return result || { ok: false, reason: 'Editor not ready after retries' };
      }
    }

    return { ok: false, reason: 'DevTools UI not reachable after retries' };
  }

  /**
   * Resumes an interrupted chat directly in the Antigravity 2.0 UI
   */
  static async resumeChat(conversationId, promptText = 'continue') {
    console.log(`[ChatResumer] Resuming chat in Antigravity 2.0 UI for: ${conversationId || 'active'}`);

    const uiResult = await this.resumeInAntigravityUi(conversationId, promptText);
    if (uiResult && uiResult.ok) {
      console.log(`[ChatResumer] ✓ Continued in Antigravity 2.0 UI (status: ${uiResult.status})`);
      return true;
    }

    console.warn(`[ChatResumer] Could not resume in UI: ${uiResult?.reason || uiResult?.status}`);
    return false;
  }

  /**
   * Schedules resumption in Antigravity 2.0 UI after a delay (e.g. after language_server respawns)
   */
  static scheduleResume(conversationId, delayMs = 6000) {
    console.log(`[ChatResumer] Scheduling UI resumption in ${delayMs}ms for: ${conversationId || 'active'}`);
    setTimeout(() => {
      this.resumeChat(conversationId, 'continue').catch((err) => {
        console.error('[ChatResumer] Error in scheduled resumption:', err.message);
      });
    }, delayMs);
    return true;
  }
}
