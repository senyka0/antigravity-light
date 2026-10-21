import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppPaths } from './paths.js';

export class ChatResumer {
  /**
   * Fast probe to verify if the UI is actively generating a response
   */
  static checkUiGenerating(webSocketDebuggerUrl) {
    if (!webSocketDebuggerUrl) return Promise.resolve(false);
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(webSocketDebuggerUrl);
      } catch {
        return resolve(false);
      }

      const tm = setTimeout(() => {
        try { ws.close(); } catch {}
        resolve(false);
      }, 1000);

      ws.onopen = () => {
        const checkScript = `
          (() => {
            const cancelBtn = Boolean(document.querySelector('button[aria-label*="Cancel"]'));
            const stopBtn = Array.from(document.querySelectorAll('button')).some(b =>
              (b.innerText || '').trim().toLowerCase().includes('stop execution') ||
              (b.getAttribute('aria-label') || '').toLowerCase().includes('stop execution')
            );
            return cancelBtn || stopBtn;
          })()
        `;
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: checkScript, returnByValue: true },
        }));
      };

      ws.onmessage = (e) => {
        clearTimeout(tm);
        try { ws.close(); } catch {}
        try {
          const val = JSON.parse(e.data)?.result?.result?.value;
          resolve(Boolean(val));
        } catch {
          resolve(false);
        }
      };

      ws.onerror = () => {
        clearTimeout(tm);
        try { ws.close(); } catch {}
        resolve(false);
      };
    });
  }

  /**
   * Checks conversation status and not_fully_idle flags in SQLite
   */
  static checkConversationState(conversationId) {
    const dbPath = AppPaths.getConversationsDb();
    if (fs.existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const row = db
            .prepare(
              `SELECT conversation_id, title, status, not_fully_idle 
               FROM conversation_summaries 
               WHERE conversation_id = ?`,
            )
            .get(conversationId);
          if (row) {
            const isRunning = row.status === 'CASCADE_RUN_STATUS_RUNNING' || row.not_fully_idle === 1;
            return {
              title: row.title,
              status: row.status,
              notFullyIdle: row.not_fully_idle,
              isRunning,
            };
          }
        } finally {
          db.close();
        }
      } catch {}
    }
    return { isRunning: false, status: 'CASCADE_RUN_STATUS_IDLE' };
  }

  /**
   * Discovers which conversation is physically open on screen in Antigravity UI,
   * accurately determining if it is actively generating or idle.
   */
  static async getActiveConversation() {
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
                const conversationId = match[1];
                const sqliteState = this.checkConversationState(conversationId);
                const isGeneratingInUi = await this.checkUiGenerating(page.webSocketDebuggerUrl);
                const isRunning = isGeneratingInUi || sqliteState.isRunning;

                return {
                  conversationId,
                  title: (page.title || sqliteState.title || 'Active Conversation').replace(/ - Antigravity.*$/, ''),
                  status: isRunning ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
                  isRunning,
                  source: 'UI_SCREEN',
                };
              }
            }
          }
        }
      }
    } catch {}

    // Fallback to SQLite
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

          let isRunning = true;

          // If no actively running flag, take the most recently active conversation
          if (!row) {
            row = db
              .prepare(
                `SELECT conversation_id, title, status, not_fully_idle 
                 FROM conversation_summaries 
                 ORDER BY last_modified_time DESC 
                 LIMIT 1`,
              )
              .get();
            isRunning = false;
          }

          if (row && row.conversation_id) {
            return {
              conversationId: row.conversation_id,
              title: row.title || 'Recent Conversation',
              status: row.status,
              isRunning: isRunning || row.status === 'CASCADE_RUN_STATUS_RUNNING' || row.not_fully_idle === 1,
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
   * Evaluates UI DOM to detect focused conversation ID, whether it is running,
   * any queued messages present, and all running conversations in sidebar.
   */
  static probeUiActiveConversations(webSocketDebuggerUrl) {
    if (!webSocketDebuggerUrl) return Promise.resolve(null);
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(webSocketDebuggerUrl);
      } catch {
        return resolve(null);
      }

      const tm = setTimeout(() => {
        try { ws.close(); } catch {}
        resolve(null);
      }, 2500);

      ws.onopen = () => {
        const probeCode = `
          (() => {
            const urlMatch = window.location.href.match(/\\/c\\/([a-zA-Z0-9-]+)/);
            const focusedId = urlMatch ? urlMatch[1] : null;

            // Check if focused conversation is running
            const cancelBtn = Boolean(document.querySelector('button[aria-label*="Cancel"]'));
            const stopBtn = Array.from(document.querySelectorAll('button')).some(b => 
              (b.innerText || '').toLowerCase().includes('stop execution') ||
              (b.getAttribute('aria-label') || '').toLowerCase().includes('stop execution')
            );
            const isFocusedRunning = cancelBtn || stopBtn;

            // Extract queued messages for focused conversation
            let focusedQueuedMessages = [];
            const card = document.querySelector('[data-testid="queued-messages-card"]');
            if (card) {
              const domTexts = Array.from(card.querySelectorAll('.line-clamp-2, [class*="line-clamp"]'))
                .map(el => (el.innerText || '').trim())
                .filter(Boolean);
              if (domTexts.length > 0) {
                focusedQueuedMessages = domTexts;
              } else {
                const fiberKey = Object.keys(card).find(k => k.startsWith('__reactFiber$'));
                if (fiberKey) {
                  let f = card[fiberKey];
                  for (let i = 0; i < 6 && f; i++) {
                    const inputs = f.memoizedProps?.pendingUserInputs || f.memoizedProps?.queuedUserInputs;
                    if (Array.isArray(inputs) && inputs.length > 0) {
                      focusedQueuedMessages = inputs.map(item => {
                        if (typeof item === 'string') return item;
                        if (item?.items && Array.isArray(item.items)) {
                          return item.items.map(it => typeof it === 'string' ? it : (it?.text || it?.value || '')).join('');
                        }
                        return item?.text || '';
                      }).filter(Boolean);
                      break;
                    }
                    f = f.return;
                  }
                }
              }
            }

            // Extract sidebar running conversations (containers having Stop execution)
            const sidebarRunningIds = [];
            const links = Array.from(document.querySelectorAll('a[href*="/c/"]'));
            for (const a of links) {
              const match = a.getAttribute('href').match(/\\/c\\/([a-zA-Z0-9-]+)/);
              if (!match) continue;
              const convId = match[1];
              let parent = a.parentElement;
              for (let i = 0; i < 4 && parent; i++) {
                const hasStop = Array.from(parent.querySelectorAll('button')).some(b => 
                  (b.getAttribute('aria-label') || '').toLowerCase().includes('stop execution') ||
                  (b.innerText || '').toLowerCase().includes('stop execution')
                );
                if (hasStop) {
                  sidebarRunningIds.push(convId);
                  break;
                }
                parent = parent.parentElement;
              }
            }

            return {
              focusedId,
              isFocusedRunning,
              focusedQueuedMessages,
              sidebarRunningIds: Array.from(new Set(sidebarRunningIds))
            };
          })()
        `;
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: probeCode, returnByValue: true },
        }));
      };

      ws.onmessage = (e) => {
        clearTimeout(tm);
        try { ws.close(); } catch {}
        try {
          const val = JSON.parse(e.data)?.result?.result?.value;
          resolve(val || null);
        } catch {
          resolve(null);
        }
      };

      ws.onerror = () => {
        clearTimeout(tm);
        try { ws.close(); } catch {}
        resolve(null);
      };
    });
  }

  /**
   * Discovers ALL conversations across UI and SQLite that are currently active or running.
   * Returns array of:
   *   { conversationId, title, isRunning, isFocused, queuedMessages: string[] }
   */
  static async getAllActiveConversations() {
    const conversations = new Map();

    // 1. Fetch from SQLite conversation_summaries
    const dbPath = AppPaths.getConversationsDb();
    if (fs.existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const rows = db.prepare(
            `SELECT conversation_id, title, status, not_fully_idle, last_modified_time 
             FROM conversation_summaries 
             WHERE status = 'CASCADE_RUN_STATUS_RUNNING' OR not_fully_idle = 1 
             ORDER BY last_modified_time DESC`,
          ).all();

          for (const row of rows) {
            conversations.set(row.conversation_id, {
              conversationId: row.conversation_id,
              title: row.title || 'Running Conversation',
              status: row.status,
              isRunning: true,
              isFocused: false,
              queuedMessages: [],
              source: 'SQLITE',
            });
          }
        } finally {
          db.close();
        }
      } catch {}
    }

    // 2. Query DevTools Active Port to find focused conversation, sidebar running indicators, and queued messages
    try {
      const devToolsFile = AppPaths.getDevToolsPortFile();
      if (devToolsFile && fs.existsSync(devToolsFile)) {
        const port = parseInt(fs.readFileSync(devToolsFile, 'utf8').split('\n')[0], 10);
        if (port) {
          const res = await fetch(`http://127.0.0.1:${port}/json`);
          if (res.ok) {
            const targets = await res.json();
            const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) {
              const probe = await this.probeUiActiveConversations(page.webSocketDebuggerUrl);
              if (probe) {
                if (probe.focusedId) {
                  let existing = conversations.get(probe.focusedId);
                  if (!existing) {
                    existing = {
                      conversationId: probe.focusedId,
                      title: (page.title || 'Active Conversation').replace(/ - Antigravity.*$/, ''),
                      isRunning: probe.isFocusedRunning,
                      isFocused: true,
                      queuedMessages: probe.focusedQueuedMessages || [],
                      source: 'UI_SCREEN',
                    };
                    conversations.set(probe.focusedId, existing);
                  } else {
                    existing.isFocused = true;
                    existing.isRunning = existing.isRunning || probe.isFocusedRunning;
                    existing.queuedMessages = probe.focusedQueuedMessages || [];
                  }
                }

                // Add any conversations from sidebar having "Stop execution"
                for (const sideId of probe.sidebarRunningIds || []) {
                  let sideItem = conversations.get(sideId);
                  if (!sideItem) {
                    const state = this.checkConversationState(sideId);
                    conversations.set(sideId, {
                      conversationId: sideId,
                      title: state.title || 'Running Chat',
                      status: 'CASCADE_RUN_STATUS_RUNNING',
                      isRunning: true,
                      isFocused: sideId === probe.focusedId,
                      queuedMessages: sideId === probe.focusedId ? (probe.focusedQueuedMessages || []) : [],
                      source: 'UI_SIDEBAR',
                    });
                  } else {
                    sideItem.isRunning = true;
                  }
                }
              }
            }
          }
        }
      }
    } catch {}

    return Array.from(conversations.values());
  }

  /**
   * Pre-switch snapshot: discovers all running conversations, their focused status,
   * and any queued messages.
   */
  static async snapshotAllRunningChats() {
    const all = await this.getAllActiveConversations();
    const runningChats = all.filter((c) => c.isRunning);
    const focused = all.find((c) => c.isFocused);
    return {
      runningChats,
      focusedChatId: focused?.conversationId || (runningChats[0]?.conversationId ?? null),
    };
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
                   (b.getAttribute("aria-label") && b.getAttribute("aria-label").includes("Cancel"))
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
   * Evaluates message enqueuing into the editor while conversation is executing.
   * Typing and sending while generation is active automatically appends to Queued Messages.
   */
  static evaluateUiEnqueue(webSocketDebuggerUrl, messageText) {
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
          resolve({ ok: false, reason: 'Timeout enqueuing message' });
        }
      }, 6000);

      let msgId = 1;
      const sendCommand = (method, params = {}) => {
        const id = msgId++;
        ws.send(JSON.stringify({ id, method, params }));
        return id;
      };

      let step = 'focus';

      ws.onopen = () => {
        const focusScript = `
          (() => {
            const editor = document.querySelector('[contenteditable="true"]');
            if (!editor) return { ok: false, reason: 'No editor found' };
            editor.focus();
            const range = document.createRange();
            range.selectNodeContents(editor);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            return { ok: true };
          })()
        `;
        sendCommand('Runtime.evaluate', { expression: focusScript, returnByValue: true });
      };

      ws.onmessage = (event) => {
        if (resolved) return;
        try {
          const msg = JSON.parse(event.data);
          if (step === 'focus' && msg.id === 1) {
            const res = msg.result?.result?.value;
            if (!res?.ok) {
              resolved = true;
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              return resolve(res || { ok: false, reason: 'Focus failed' });
            }
            step = 'typing';
            sendCommand('Input.insertText', { text: messageText });
            return;
          }

          if (step === 'typing' && msg.id === 2) {
            step = 'submitting';
            setTimeout(() => {
              const submitScript = `
                (() => {
                  const sendBtn = document.querySelector('button[aria-label="Send message"]');
                  if (sendBtn && !sendBtn.disabled) {
                    sendBtn.click();
                    return { clicked: true };
                  }
                  return { clicked: false };
                })()
              `;
              sendCommand('Runtime.evaluate', { expression: submitScript, returnByValue: true });
            }, 80);
            return;
          }

          if (step === 'submitting' && msg.id === 3) {
            const subRes = msg.result?.result?.value;
            if (subRes?.clicked) {
              resolved = true;
              clearTimeout(timeout);
              try { ws.close(); } catch {}
              return resolve({ ok: true, status: 'enqueued_via_button' });
            }

            // Fallback to Enter key
            step = 'enter_key';
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

          if (step === 'enter_key' && msg.id >= 5) {
            resolved = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            return resolve({ ok: true, status: 'enqueued_via_enter' });
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
        resolve({ ok: false, reason: err.message });
      };
    });
  }

  /**
   * Navigates the open Antigravity window to a specific conversation ID.
   */
  static async navigateToConversation(conversationId) {
    try {
      const devToolsFile = AppPaths.getDevToolsPortFile();
      if (!devToolsFile || !fs.existsSync(devToolsFile)) return false;
      const port = parseInt(fs.readFileSync(devToolsFile, 'utf8').split('\n')[0], 10);
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (!page) return false;

      return new Promise((resolve) => {
        let ws;
        try {
          ws = new WebSocket(page.webSocketDebuggerUrl);
        } catch {
          return resolve(false);
        }
        const tm = setTimeout(() => {
          try { ws.close(); } catch {}
          resolve(false);
        }, 3000);

        ws.onopen = () => {
          const navScript = `
            (() => {
              const targetId = ${JSON.stringify(conversationId)};
              if (window.location.href.includes(targetId)) return { navigated: true };
              const link = document.querySelector('a[href*="' + targetId + '"]');
              if (link) {
                link.click();
                return { navigated: true };
              }
              window.location.href = window.location.origin + '/c/' + targetId;
              return { navigated: true };
            })()
          `;
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: navScript, returnByValue: true } }));
        };

        ws.onmessage = () => {
          clearTimeout(tm);
          try { ws.close(); } catch {}
          resolve(true);
        };

        ws.onerror = () => {
          clearTimeout(tm);
          try { ws.close(); } catch {}
          resolve(false);
        };
      });
    } catch {
      return false;
    }
  }

  /**
   * Resumes conversation directly in Antigravity 2.0 UI via Chrome DevTools Protocol with retry polling
   */
  static async resumeInAntigravityUi(conversationId, promptText = 'continue', maxAttempts = 15, intervalMs = 1000) {
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
   * Resumes a single conversation (sending continue to active turn)
   * and subsequently restores any queued messages in order into Antigravity UI.
   */
  static async resumeConversationWithQueue(conversationId, options = {}) {
    const promptText = options.promptText || 'continue';
    const queuedMessages = options.queuedMessages || [];

    console.log(`[ChatResumer] Resuming conversation: ${conversationId} (queued messages: ${queuedMessages.length})`);

    // 1. Resume the in-flight turn
    const resumeRes = await this.resumeInAntigravityUi(conversationId, promptText);
    if (!resumeRes?.ok) {
      console.warn(`[ChatResumer] Could not resume active turn for ${conversationId}: ${resumeRes?.reason}`);
      return { ok: false, conversationId, reason: resumeRes?.reason };
    }

    console.log(`[ChatResumer] ✓ Active turn resumed for ${conversationId} (status: ${resumeRes.status})`);

    // 2. If no queued messages were captured, we are done
    if (!queuedMessages || queuedMessages.length === 0) {
      return { ok: true, conversationId, queuedRestored: 0 };
    }

    // 3. Wait for execution to be registered before enqueuing
    await new Promise((r) => setTimeout(r, 1200));

    // Get page websocket
    const devToolsFile = AppPaths.getDevToolsPortFile();
    if (!devToolsFile || !fs.existsSync(devToolsFile)) {
      return { ok: true, conversationId, queuedRestored: 0 };
    }

    const port = parseInt(fs.readFileSync(devToolsFile, 'utf8').split('\n')[0], 10);
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    const targets = await res.json();
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) {
      return { ok: true, conversationId, queuedRestored: 0 };
    }

    let restoredCount = 0;
    for (let i = 0; i < queuedMessages.length; i++) {
      const qMsg = queuedMessages[i];
      console.log(`[ChatResumer] Restoring queued message [${i + 1}/${queuedMessages.length}] for ${conversationId}: "${qMsg.slice(0, 45)}..."`);
      const eqRes = await this.evaluateUiEnqueue(page.webSocketDebuggerUrl, qMsg);
      if (eqRes.ok) {
        restoredCount++;
      } else {
        console.warn(`[ChatResumer] Failed to enqueue message: ${eqRes.reason}`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    console.log(`[ChatResumer] ✓ Restored ${restoredCount}/${queuedMessages.length} queued messages for ${conversationId}`);
    return { ok: true, conversationId, queuedRestored: restoredCount };
  }

  /**
   * Resumes ALL active conversations recorded in snapshot.
   * Restores queued messages for each conversation.
   * Restores focus back to the originally focused conversation.
   */
  static async resumeAllActiveConversations(snapshot) {
    if (!snapshot || !snapshot.runningChats || snapshot.runningChats.length === 0) {
      console.log('[ChatResumer] No active conversations were running before switch.');
      return [];
    }

    const running = snapshot.runningChats;
    const focusedId = snapshot.focusedChatId || running[0].conversationId;
    console.log(`[ChatResumer] Resuming ${running.length} active conversation(s)... (focused: ${focusedId})`);

    const results = [];

    // Prioritize focused conversation first
    const sorted = [...running].sort((a, b) => {
      if (a.conversationId === focusedId) return -1;
      if (b.conversationId === focusedId) return 1;
      return 0;
    });

    for (const chat of sorted) {
      console.log(`\n[ChatResumer] >> Continuing conversation: "${chat.title}" (${chat.conversationId})...`);
      
      const res = await this.resumeConversationWithQueue(chat.conversationId, {
        promptText: 'continue',
        queuedMessages: chat.queuedMessages || [],
        isFocused: chat.conversationId === focusedId,
      });
      results.push({ ...chat, resumeResult: res });

      if (sorted.length > 1) {
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    // Restore focus to original conversation if needed
    if (sorted.length > 1 && focusedId) {
      console.log(`[ChatResumer] Restoring active focus to original conversation: ${focusedId}`);
      await this.navigateToConversation(focusedId);
    }

    console.log(`[ChatResumer] ✓ Completed resuming all active conversations!\n`);
    return results;
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
   * Schedules resumption in Antigravity 2.0 UI after a delay
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
