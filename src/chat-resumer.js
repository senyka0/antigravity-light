import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppPaths } from './paths.js';

export class ChatResumer {
  /**
   * Discovers which conversation is physically open on screen in Antigravity UI,
   * falling back to the most recently modified conversation in SQLite.
   */
  static async getActiveConversation() {
    // 1. Check DevTools to find what conversation is physically displayed on screen in Antigravity UI
    try {
      const devToolsFile = AppPaths.getDevToolsPortFile();
      if (devToolsFile && fs.existsSync(devToolsFile)) {
        const port = parseInt(fs.readFileSync(devToolsFile, 'utf8').split('\n')[0], 10);
        if (port) {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            const page = targets.find((t) => t.type === 'page' && t.url && t.url.includes('/c/'));
            if (page) {
              const match = page.url.match(/\/c\/([a-zA-Z0-9-]+)/);
              if (match) {
                return {
                  conversationId: match[1],
                  title: (page.title || 'Active Conversation').replace(/ - Antigravity.*$/, ''),
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  source: 'UI_SCREEN',
                };
              }
            }
          }
        }
      }
    } catch {}

    // 2. Fallback to SQLite
    return this.findActiveConversation();
  }

  /**
   * Synchronously checks SQLite for the active or most recently modified conversation
   */
  static findActiveConversation() {
    const dbPath = AppPaths.getConversationsDb();
    if (fs.existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          // Check actively running or not idle first
          let row = db
            .prepare(
              `SELECT conversation_id, title, status, not_fully_idle 
               FROM conversation_summaries 
               WHERE status = 'CASCADE_RUN_STATUS_RUNNING' OR not_fully_idle = 1 
               ORDER BY last_modified_time DESC 
               LIMIT 1`,
            )
            .get();

          // If no actively running flag, take the most recently active conversation
          if (!row) {
            row = db
              .prepare(
                `SELECT conversation_id, title, status 
                 FROM conversation_summaries 
                 ORDER BY last_modified_time DESC 
                 LIMIT 1`,
              )
              .get();
          }

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
      }, 10000);

      let msgId = 1;
      const sendCommand = (method, params = {}) => {
        const id = msgId++;
        ws.send(JSON.stringify({ id, method, params }));
        return id;
      };

      let pendingStep = 'check';

      ws.onopen = () => {
        // Step 1: Check UI state (running, buttons, editor)
        const checkScript = `
          (() => {
            // Check if on a different conversation
            const targetId = ${JSON.stringify(conversationId || '')};
            if (targetId && !window.location.href.includes(targetId)) {
              const link = document.querySelector('a[href*="' + targetId + '"]');
              if (link) {
                link.click();
                return { action: "navigating" };
              }
            }

            // Check if already generating
            const stopBtn = Array.from(document.querySelectorAll("button")).find(
              b => (b.innerText && b.innerText.trim().toLowerCase().includes("stop execution")) ||
                   b.getAttribute("aria-label") === "Cancel (Ctrl+D)"
            );
            if (stopBtn) {
              return { action: "already_running" };
            }

            // Look for explicit Continue/Resume button
            const continueBtn = Array.from(document.querySelectorAll("button")).find(
              b => b.innerText && (b.innerText.trim().toLowerCase() === "continue" || b.innerText.trim().toLowerCase() === "resume")
            );
            if (continueBtn && !continueBtn.disabled) {
              continueBtn.click();
              return { action: "clicked_continue" };
            }

            // Check Lexical editor
            const editor = document.querySelector("[contenteditable=\\"true\\"]");
            if (!editor) {
              return { action: "editor_not_found" };
            }

            editor.focus();
            const range = document.createRange();
            range.selectNodeContents(editor);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return { action: "ready_to_type" };
          })()
        `;

        sendCommand('Runtime.evaluate', { expression: checkScript, returnByValue: true });
      };

      ws.onmessage = (event) => {
        if (resolved) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.error) {
            resolved = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            return resolve({ ok: false, reason: msg.error.message });
          }

          if (pendingStep === 'check' && msg.id === 1) {
            const res = msg.result?.result?.value;
            if (!res) {
              resolved = true;
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              return resolve({ ok: false, reason: 'Empty response checking UI' });
            }

            if (res.action === 'already_running') {
              resolved = true;
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              return resolve({ ok: true, status: 'already_running' });
            }

            if (res.action === 'clicked_continue') {
              resolved = true;
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              return resolve({ ok: true, status: 'clicked_continue_button' });
            }

            if (res.action === 'navigating') {
              resolved = true;
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              return resolve({ ok: false, status: 'navigating_to_conversation' });
            }

            if (res.action === 'ready_to_type') {
              pendingStep = 'typing';
              // Native CDP Input event inserts text reliably into Lexical
              sendCommand('Input.insertText', { text: promptText });
              return;
            }

            resolved = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            return resolve({ ok: false, reason: res.action || 'Unknown UI state' });
          }

          if (pendingStep === 'typing' && msg.id === 2) {
            pendingStep = 'submitting';
            // Click send button or dispatch Enter
            setTimeout(() => {
              const submitScript = `
                (() => {
                  const sendBtn = document.querySelector('button[aria-label="Send message"]');
                  if (sendBtn && !sendBtn.disabled) {
                    sendBtn.click();
                    return { clicked: true };
                  }
                  return { clicked: false, sendBtnExists: !!sendBtn, sendBtnDisabled: sendBtn?.disabled };
                })()
              `;
              sendCommand('Runtime.evaluate', { expression: submitScript, returnByValue: true });
            }, 80);
            return;
          }

          if (pendingStep === 'submitting' && msg.id === 3) {
            const subRes = msg.result?.result?.value;
            if (subRes?.clicked) {
              resolved = true;
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              return resolve({ ok: true, status: 'sent_prompt_in_ui', prompt: promptText });
            }

            // Fallback: Dispatch Enter key event via CDP
            pendingStep = 'enter_key';
            sendCommand('Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              windowsVirtualKeyCode: 13,
              unmodifiedText: '\\r',
              text: '\\r',
              key: 'Enter',
              code: 'Enter',
            });
            setTimeout(() => {
              sendCommand('Input.dispatchKeyEvent', {
                type: 'keyUp',
                windowsVirtualKeyCode: 13,
                unmodifiedText: '\\r',
                text: '\\r',
                key: 'Enter',
                code: 'Enter',
              });
            }, 50);
            return;
          }

          if (pendingStep === 'enter_key' && msg.id >= 5) {
            resolved = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            return resolve({ ok: true, status: 'sent_prompt_via_enter', prompt: promptText });
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
