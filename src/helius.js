import { config } from './config.js';

const cache = new Map();
let queue = Promise.resolve();
let nextAllowedAt = 0;
let backoffUntil = 0;

const stats = {
  startedAt: Date.now(),
  requests: 0,
  cacheHits: 0,
  rateLimited: 0,
  failures: 0,
  quotaExhausted: false,
  lastStatus: 0,
  lastError: null,
  lastRequestAt: 0,
  backoffUntil: 0,
};

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function retryAfterMs(res, attempt) {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(config.heliusBackoffMaxMs, header * 1000);
  return Math.min(config.heliusBackoffMaxMs, config.heliusBackoffBaseMs * (2 ** attempt));
}

function cooldownError(message = 'Helius cooling down after rate limit') {
  const seconds = Math.max(1, Math.ceil((backoffUntil - Date.now()) / 1000));
  const e = new Error(`${message} (${seconds}s remaining)`);
  e.status = 429;
  e.retryAfterMs = Math.max(0, backoffUntil - Date.now());
  e.quotaExhausted = stats.quotaExhausted;
  return e;
}

async function requestJson(url) {
  const run = async () => {
    if (Date.now() < backoffUntil) throw cooldownError(stats.quotaExhausted ? 'Helius quota exhausted; cooldown active' : undefined);

    const wait = Math.max(0, nextAllowedAt - Date.now());
    if (wait) await sleep(wait);
    nextAllowedAt = Date.now() + config.heliusMinIntervalMs;

    for (let attempt = 0; attempt <= config.heliusMaxRetries; attempt++) {
      stats.requests++;
      stats.lastRequestAt = Date.now();
      let res;
      try {
        res = await fetch(url);
      } catch (e) {
        stats.failures++;
        stats.lastError = String(e.message || e);
        if (attempt >= config.heliusMaxRetries) throw e;
        await sleep(Math.min(5000, 500 * (2 ** attempt)));
        continue;
      }

      stats.lastStatus = res.status;
      if (res.ok) {
        stats.lastError = null;
        stats.quotaExhausted = false;
        return res.json();
      }

      const body = await res.text();
      if (res.status === 429) {
        stats.rateLimited++;
        const quotaExhausted = /max usage reached|usage limit|quota.*exhaust|credits.*exhaust/i.test(body);
        stats.quotaExhausted = quotaExhausted;
        const retryMs = quotaExhausted ? config.heliusBackoffMaxMs : retryAfterMs(res, attempt);
        backoffUntil = Date.now() + retryMs;
        stats.backoffUntil = backoffUntil;
        stats.lastError = `Helius 429: ${body.slice(0, 250)}`;

        // Monthly/project quota exhaustion will not recover from an immediate
        // retry, so do not create a retry storm. Let the monitor cool down and
        // surface the state through /health.
        if (quotaExhausted) throw cooldownError('Helius max usage reached');

        if (attempt < config.heliusMaxRetries) {
          await sleep(retryMs);
          backoffUntil = 0;
          stats.backoffUntil = 0;
          continue;
        }
        throw cooldownError();
      }

      stats.failures++;
      stats.lastError = `Helius ${res.status}: ${body.slice(0, 250)}`;
      const e = new Error(stats.lastError);
      e.status = res.status;
      throw e;
    }

    throw new Error('Helius request failed');
  };

  const task = queue.then(run, run);
  queue = task.catch(() => {});
  return task;
}

export async function getRecentTransactions(address, limit = 10, options = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
  const key = `${address}:${safeLimit}`;
  const cached = cache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at <= config.heliusCacheMs) {
    stats.cacheHits++;
    return cached.value;
  }

  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${config.heliusApiKey}&limit=${safeLimit}`;
  const value = await requestJson(url);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function getHeliusStats() {
  return {
    ...stats,
    backoffUntil,
    coolingDown: Date.now() < backoffUntil,
    cacheEntries: cache.size,
    uptimeSec: Math.floor((Date.now() - stats.startedAt) / 1000),
  };
}

export function isHeliusRateLimitError(error) {
  return Number(error?.status) === 429 || /Helius.*429|rate limit|cooling down|max usage/i.test(String(error?.message || error));
}
