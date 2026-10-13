import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
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

    return null;
  }

  /**
   * Builds the arguments for `agy` to resume the conversation in Antigravity
   */
  static getResumeArgs(conversationId) {
    const args = ['--app_data_dir', 'antigravity'];
    if (conversationId) {
      args.push('--conversation', conversationId);
    } else {
      args.push('-c');
    }
    args.push('-p', 'continue', '--dangerously-skip-permissions');
    return args;
  }

  /**
   * Schedules a detached background process to resume the chat after delayMs
   * Survives even if language_server is killed or restarts.
   */
  static scheduleResume(conversationId, delayMs = 5000) {
    const agyCli = AppPaths.getAgyCli();
    const args = this.getResumeArgs(conversationId);

    console.log(`[ChatResumer] Scheduling auto-resumption in ${delayMs}ms for: ${conversationId || 'latest chat'}`);

    const helperScript = `
      setTimeout(() => {
        const { spawn } = require('node:child_process');
        try {
          const child = spawn(${JSON.stringify(agyCli)}, ${JSON.stringify(args)}, {
            detached: true,
            stdio: 'ignore'
          });
          child.unref();
        } catch (e) {}
      }, ${delayMs});
    `;

    try {
      const helper = spawn('node', ['-e', helperScript], {
        detached: true,
        stdio: 'ignore',
      });
      helper.unref();
      return true;
    } catch (err) {
      console.error('[ChatResumer] Failed to schedule resume helper:', err.message);
      return false;
    }
  }

  /**
   * Resumes an interrupted chat immediately using `agy` CLI
   */
  static async resumeChat(conversationId) {
    const agyCli = AppPaths.getAgyCli();
    const args = this.getResumeArgs(conversationId);

    console.log(`[ChatResumer] Resuming interrupted chat with command: ${agyCli} ${args.join(' ')}`);

    return new Promise((resolve) => {
      try {
        const child = spawn(agyCli, args, {
          detached: true,
          stdio: 'ignore',
        });

        child.unref();
        child.on('error', (err) => {
          console.error('[ChatResumer] Failed to spawn agy resume process:', err.message);
          resolve(false);
        });

        // Give a moment to verify process didn't immediately crash
        setTimeout(() => resolve(true), 500);
      } catch (err) {
        console.error('[ChatResumer] Error triggering chat resume:', err);
        resolve(false);
      }
    });
  }
}

