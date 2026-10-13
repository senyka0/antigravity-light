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
   * Resumes conversation directly in Antigravity 2.0 UI via Chrome DevTools Protocol
   */
  static async resumeInAntigravityUi(conversationId, promptText = 'continue') {
    const devToolsFile = AppPaths.getDevToolsPortFile();
    if (!devToolsFile || !fs.existsSync(devToolsFile)) {
      return { ok: false, reason: 'DevToolsActivePort file not found' };
    }

    let port;
    try {
      const content = fs.readFileSync(devToolsFile, 'utf8').trim().split('\n');
      port = parseInt(content[0], 10);
      if (!port || isNaN(port)) {
        return { ok: false, reason: 'Invalid DevTools port' };
      }
    } catch (err) {
      return { ok: false, reason: err.message };
    }

    let targets;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status} from DevTools` };
      targets = await res.json();
    } catch (err) {
      return { ok: false, reason: `Cannot reach DevTools on port ${port}: ${err.message}` };
    }

    if (!Array.isArray(targets) || targets.length === 0) {
      return { ok: false, reason: 'No DevTools targets found' };
    }

    // Find the Antigravity window target
    let target = null;
    if (conversationId) {
      target = targets.find((t) => t.url && t.url.includes(conversationId));
    }
    if (!target) {
      target = targets.find(
        (t) => t.type === 'page' && (t.url.includes('/c/') || (t.title && t.title.includes('Antigravity'))),
      );
    }
    if (!target) {
      target = targets.find((t) => t.type === 'page');
    }

    if (!target || !target.webSocketDebuggerUrl) {
      return { ok: false, reason: 'No Antigravity UI page found with WebSocket debugger' };
    }

    console.log(`[ChatResumer] Connecting to Antigravity 2.0 UI: "${target.title}"`);

    return new Promise((resolve) => {
      let resolved = false;
      const ws = new WebSocket(target.webSocketDebuggerUrl);

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { ws.close(); } catch {}
          resolve({ ok: false, reason: 'Timeout waiting for Antigravity UI response' });
        }
      }, 10000);

      ws.onopen = () => {
        const expression = `
          (() => {
            // Check if already generating
            const stopBtn = Array.from(document.querySelectorAll("button")).find(
              b => b.innerText && b.innerText.trim().toLowerCase().includes("stop execution")
            );
            if (stopBtn) {
              return JSON.stringify({ ok: true, status: "already_running" });
            }

            // Look for explicit Continue/Resume button
            const continueBtn = Array.from(document.querySelectorAll("button")).find(
              b => b.innerText && (b.innerText.trim().toLowerCase() === "continue" || b.innerText.trim().toLowerCase() === "resume")
            );
            if (continueBtn && !continueBtn.disabled) {
              continueBtn.click();
              return JSON.stringify({ ok: true, status: "clicked_continue_button" });
            }

            // Target the editor
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
        resolve({ ok: false, reason: err.message || 'WebSocket connection error' });
      };
    });
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
