import { readFile } from 'node:fs/promises';

export class SafeError extends Error {
  constructor(code) { super(code); this.name = 'SafeError'; this.code = code; }
}

export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}

export function dateInZone(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return p.year + '-' + p.month + '-' + p.day;
}

export function safeUrl(value, allowedHosts) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (!allowedHosts.includes(url.hostname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function validateConfig(value, { requireArchive = true } = {}) {
  if (!value || typeof value !== 'object' || !/^[a-z0-9-]{1,50}$/.test(value.id || '')) throw new SafeError('CONFIG_INVALID_SITE');
  if (typeof value.name !== 'string' || value.name.length > 100) throw new SafeError('CONFIG_INVALID_SITE');
  try { dateInZone(new Date(), value.timezone); } catch { throw new SafeError('CONFIG_INVALID_TIMEZONE'); }
  if (!Array.isArray(value.allowed_hosts) || !value.allowed_hosts.length || value.allowed_hosts.length > 10
      || value.allowed_hosts.some(h => typeof h !== 'string' || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(h))) throw new SafeError('CONFIG_INVALID_HOSTS');
  if (!safeUrl(value.url, value.allowed_hosts)) throw new SafeError('CONFIG_INVALID_URL');
  if (!Array.isArray(value.pages) || value.pages.length > 50 || value.pages.some(u => !safeUrl(u, value.allowed_hosts))) throw new SafeError('CONFIG_INVALID_PAGES');
  if (!Number.isInteger(value.page_limit) || value.page_limit < 1 || value.page_limit > 50) throw new SafeError('CONFIG_INVALID_PAGE_LIMIT');
  if (typeof value.gsc?.property !== 'string' || !value.gsc.property.length) throw new SafeError('CONFIG_GSC_PROPERTY_REQUIRED');
  if (!Number.isInteger(value.gsc.history_days) || value.gsc.history_days < 56 || value.gsc.history_days > 365) throw new SafeError('CONFIG_INVALID_HISTORY');
  if (!Number.isInteger(value.gsc.detail_limit) || value.gsc.detail_limit < 1 || value.gsc.detail_limit > 25000) throw new SafeError('CONFIG_INVALID_DETAIL_LIMIT');
  if (value.ga4?.property_id !== null && value.ga4?.property_id !== undefined && !/^\d+$/.test(String(value.ga4.property_id))) throw new SafeError('CONFIG_INVALID_GA4_PROPERTY');
  if (value.model?.provider_base_url !== 'https://api.deepseek.com/anthropic') throw new SafeError('CONFIG_UNAPPROVED_MODEL_ENDPOINT');
  if (typeof value.model.id !== 'string' || !/^[a-zA-Z0-9._:[\]-]{1,100}$/.test(value.model.id)) throw new SafeError('CONFIG_INVALID_MODEL');
  if (!/^\d+\.\d+\.\d+$/.test(value.model.claude_code_version || '')) throw new SafeError('CONFIG_INVALID_CLAUDE_VERSION');
  if (!Number.isInteger(value.model.timeout_seconds) || value.model.timeout_seconds < 10 || value.model.timeout_seconds > 1800) throw new SafeError('CONFIG_INVALID_MODEL_TIMEOUT');
  if (!Number.isInteger(value.model.max_turns) || value.model.max_turns < 1 || value.model.max_turns > 5) throw new SafeError('CONFIG_INVALID_MODEL_TURNS');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.archive?.repository || '')) throw new SafeError('CONFIG_INVALID_REPORTS_REPOSITORY');
  if (requireArchive && (!Number.isSafeInteger(Number(value.archive.repository_id)) || Number(value.archive.repository_id) <= 0)) throw new SafeError('CONFIG_REPORTS_REPOSITORY_ID_REQUIRED');
  return value;
}

export async function loadConfig(path, options) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new SafeError('CONFIG_UNREADABLE'); }
  return validateConfig(value, options);
}
