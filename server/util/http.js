import { setTimeout as delay } from 'node:timers/promises';
import { publicNetwork, publicUrl } from './public-network.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 JobIntel/1.0';
const HOST_GAP_MS = {
  'www.reddit.com': 70_000,
  'reddit.com': 70_000,
  'oauth.reddit.com': 1000,
  'news.google.com': 2500,
  'hn.algolia.com': 1000,
};

const hostState = new Map();
const MAX_REQUESTS = 24;
let activeRequests = 0;

function stateFor(host) {
  if (hostState.has(host)) return hostState.get(host);
  if (hostState.size >= 1000) {
    const now = Date.now();
    for (const [key, state] of hostState) {
      if (!state.active && state.cooldownUntil <= now && state.nextAt <= now) hostState.delete(key);
    }
    if (hostState.size >= 1000) throw new Error('Too many active hosts');
  }
  const state = { nextAt: 0, cooldownUntil: 0, active: 0 };
  hostState.set(host, state);
  return state;
}

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

export async function fetchText(url, { timeoutMs = 20_000, maxBytes = 6_000_000, headers = {}, accept } = {}) {
  let target = publicUrl(url);
  const origin = target.origin;
  if (activeRequests >= MAX_REQUESTS) throw new HttpError(429, target.href);
  activeRequests++;
  const signal = AbortSignal.timeout(timeoutMs);
  const deadline = Date.now() + timeoutMs;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const host = target.hostname;
      const state = stateFor(host);
      const now = Date.now();
      const start = Math.max(now, state.nextAt);
      if (state.cooldownUntil > now || start >= deadline) throw new HttpError(429, target.href);
      state.nextAt = start + (HOST_GAP_MS[host] || 1200);
      state.active++;
      try {
        if (start > now) await delay(start - now, undefined, { signal });
        if (state.cooldownUntil > Date.now()) throw new HttpError(429, target.href);
        const response = await fetch(target.href, {
          signal,
          dispatcher: publicNetwork,
          redirect: 'manual',
          headers: {
            'user-agent': UA,
            accept: accept || 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.9, */*;q=0.8',
            'accept-language': 'en-IN,en;q=0.9',
            ...(target.origin === origin ? headers : {}),
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects === 5) throw new Error('Invalid or excessive redirects');
          target = publicUrl(new URL(location, target));
          continue;
        }
        if (!response.ok) {
          if ([429, 503].includes(response.status)) {
            state.cooldownUntil = Date.now() + (host === 'reddit.com' || host.endsWith('.reddit.com') ? 15 : 5) * 60_000;
          }
          await response.body?.cancel();
          throw new HttpError(response.status, target.href);
        }
        const chunks = [];
        let size = 0;
        const reader = response.body?.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) {
            await reader.cancel();
            throw new Error('Response exceeded the size limit');
          }
          chunks.push(value);
        }
        return { text: Buffer.concat(chunks, size).toString('utf8'), finalUrl: response.url || target.href, headers: response.headers };
      } finally {
        state.active--;
      }
    }
  } finally {
    activeRequests--;
  }
}

export async function fetchJson(url, opts = {}) {
  const { text } = await fetchText(url, { ...opts, accept: 'application/json' });
  return JSON.parse(text);
}
