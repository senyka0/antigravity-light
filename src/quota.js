import { AppPaths } from './paths.js';
import { AuthService } from './auth.js';
import { AccountsStore } from './storage.js';
import { ConfigManager } from './config.js';

const LOAD_PROJECT_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
];

const QUOTA_SUMMARY_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
];

const MODELS_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];

export class QuotaChecker {
  static async fetchProjectId(accessToken) {
    const userAgent = AppPaths.getUserAgent();
    const payload = JSON.stringify({
      metadata: {
        ide_type: 'ANTIGRAVITY',
        ide_version: '2.0.3',
        ide_name: 'antigravity',
      },
    });

    for (const url of LOAD_PROJECT_ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': userAgent,
            'Content-Type': 'application/json',
          },
          body: payload,
        });

        if (res.ok) {
          const data = await res.json();
          if (data?.cloudaicompanionProject) {
            return data.cloudaicompanionProject;
          }
        }
      } catch {}
    }
    return null;
  }

  static async fetchQuotaSummary(accessToken, projectId) {
    const userAgent = AppPaths.getUserAgent();
    const payload = JSON.stringify(projectId ? { project: projectId } : {});

    for (const url of QUOTA_SUMMARY_ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': userAgent,
            'Content-Type': 'application/json',
          },
          body: payload,
        });

        if (res.ok) {
          return await res.json();
        }
      } catch {}
    }
    return null;
  }

  static async fetchAvailableModels(accessToken, projectId) {
    const userAgent = AppPaths.getUserAgent();
    const payload = JSON.stringify(projectId ? { project: projectId } : {});

    for (const url of MODELS_ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': userAgent,
            'Content-Type': 'application/json',
          },
          body: payload,
        });

        if (res.ok) {
          return await res.json();
        }
      } catch {}
    }
    return null;
  }

  /**
   * Checks limits specifically for Gemini Flash 3.8 High:
   * - 5 hour rolling limit
   * - 5 day / weekly limit
   */
  static async checkAccount(account) {
    const validAccount = await AuthService.ensureValidToken(account);
    const token = validAccount.accessToken;

    let projectId = validAccount.projectId;
    if (!projectId) {
      projectId = await this.fetchProjectId(token);
      if (projectId) {
        AccountsStore.upsertAccount({ ...validAccount, projectId });
      }
    }

    const [summary, modelsData] = await Promise.all([
      this.fetchQuotaSummary(token, projectId),
      this.fetchAvailableModels(token, projectId),
    ]);

    let flash5h = 100;
    let flash5d = 100;
    let resetTime5h = null;
    let resetTime5d = null;
    let resetDesc5h = null;
    let resetDesc5d = null;
    const modelPercentages = {};

    // 1. Parse Quota Groups and Buckets (5h & 5d/weekly windows)
    if (summary?.groups && Array.isArray(summary.groups)) {
      for (const group of summary.groups) {
        const groupText = [group.displayName, group.description]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        // Skip non-Gemini groups
        if (groupText.includes('claude') || groupText.includes('gpt')) {
          continue;
        }

        for (const bucket of group.buckets || []) {
          const bucketText = [
            bucket.bucketId,
            bucket.window,
            bucket.displayName,
            bucket.description,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          const pct = Math.round((bucket.remainingFraction ?? 1) * 100);

          const is5h =
            bucketText.includes('5h') ||
            bucketText.includes('5-hour') ||
            bucketText.includes('5 hour');
          const is5d =
            bucketText.includes('week') ||
            bucketText.includes('5d') ||
            bucketText.includes('5-day') ||
            bucketText.includes('5 day') ||
            bucketText.includes('7d');

          if (is5h) {
            flash5h = Math.min(flash5h, pct);
            if (bucket.resetTime) {
              resetTime5h = bucket.resetTime;
            }
            if (bucket.description) {
              resetDesc5h = bucket.description;
            }
          }
          if (is5d) {
            flash5d = Math.min(flash5d, pct);
            if (bucket.resetTime) {
              resetTime5d = bucket.resetTime;
            }
            if (bucket.description) {
              resetDesc5d = bucket.description;
            }
          }
        }
      }
    }

    // 2. Parse Model Specific Quotas
    if (modelsData?.models) {
      for (const [modelId, info] of Object.entries(modelsData.models)) {
        if (info?.quotaInfo?.remainingFraction !== undefined) {
          const pct = Math.round(info.quotaInfo.remainingFraction * 100);
          modelPercentages[modelId] = pct;

          if (modelId.toLowerCase().includes('flash')) {
            // Flash model base quota limit
            flash5h = Math.min(flash5h, pct);
          }
        }
      }
    }

    const config = ConfigManager.load();
    const threshold = config.depletionThresholdPercent ?? 5;
    const isDepleted = flash5h <= threshold || flash5d <= threshold;

    const quotaResult = {
      flash5h,
      flash5d,
      resetTime5h,
      resetTime5d,
      resetDesc5h,
      resetDesc5d,
      models: modelPercentages,
      lastChecked: Date.now(),
      isDepleted,
      depletionReason: isDepleted
        ? flash5h <= threshold
          ? `Flash 3.8 5-hour limit <= ${flash5h}%`
          : `Flash 3.8 5-day limit <= ${flash5d}%`
        : null,
    };

    AccountsStore.updateQuota(validAccount.id, quotaResult);
    return quotaResult;
  }
}
