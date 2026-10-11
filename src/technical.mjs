import { createHash } from 'node:crypto';
import { safeUrl } from './config.mjs';

function decode(text = '') {
  return text.replace(/&#(x[0-9a-f]+|\d+);|&(amp|quot|apos|lt|gt|nbsp);/gi, (match, numeric, name) => {
    if (numeric) {
      const code = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
    }
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }[name.toLowerCase()];
  }).replace(/\s+/g, ' ').trim();
}

function attributes(tag) {
  const result = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) result[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4]);
  return result;
}

export function parsePage(html, finalUrl, headers = new Headers()) {
  // This intentionally inspects static HTML only; it is not a rendered browser audit.
  const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const title = decode(text.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '');
  const metas = [...text.matchAll(/<meta\b[^>]*>/gi)].map(m => attributes(m[0]));
  const description = metas.find(m => m.name?.toLowerCase() === 'description')?.content || '';
  const robots = metas.filter(m => ['robots', 'googlebot'].includes(m.name?.toLowerCase())).map(m => m.content || '');
  const headerRobots = headers.get('x-robots-tag');
  if (headerRobots) robots.push(headerRobots);
  const links = [...text.matchAll(/<link\b[^>]*>/gi)].map(m => attributes(m[0]));
  const canonicalValue = links.find(l => l.rel?.toLowerCase().split(/\s+/).includes('canonical'))?.href;
  let canonical = null;
  if (canonicalValue) { try { canonical = new URL(canonicalValue, finalUrl).href; } catch { canonical = canonicalValue; } }
  const h1 = [...text.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)].map(m => decode(m[1].replace(/<[^>]*>/g, ''))).slice(0, 10);
  return { title: title.slice(0, 1000), description: description.slice(0, 3000),
    canonical: canonical?.slice(0, 3000) || null, robots: robots.join(', ').slice(0, 2000),
    noindex: robots.some(value => /(?:^|[\s,:;])(?:noindex|none)(?:$|[\s,;])/i.test(value)), h1 };
}

async function boundedText(response) {
  if (Number(response.headers.get('content-length')) > 2_000_000) throw new Error('BODY_LIMIT');
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2_000_000) throw new Error('BODY_LIMIT');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchPage(url, config, { fetchImpl = fetch, now = new Date() } = {}) {
  const base = { url, checked_at: now.toISOString() };
  let current = safeUrl(url, config.allowed_hosts);
  if (!current) return { ...base, check_status: 'error', error_code: 'PAGE_URL_REJECTED' };
  try {
    for (let redirects = 0; redirects <= 4; redirects++) {
      const response = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': 'NocoBaseGrowth/0.1 (+https://github.com/gchust/nocobase-growth)', accept: 'text/html,application/xhtml+xml' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('REDIRECT');
        current = safeUrl(new URL(location, current).href, config.allowed_hosts);
        if (!current) return { ...base, check_status: 'error', error_code: 'PAGE_REDIRECT_REJECTED' };
        continue;
      }
      const common = { ...base, final_url: current, status_code: response.status, check_status: 'ok' };
      if (!response.ok) { await response.body?.cancel(); return common; }
      if (!/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel(); return { ...common, check_status: 'error', error_code: 'PAGE_NOT_HTML' };
      }
      return { ...common, ...parsePage(await boundedText(response), current, response.headers) };
    }
    return { ...base, check_status: 'error', error_code: 'PAGE_TOO_MANY_REDIRECTS' };
  } catch { return { ...base, check_status: 'error', error_code: 'PAGE_FETCH_FAILED' }; }
}

function findingId(url, kind) { return 'page-' + createHash('sha256').update(url + '|' + kind).digest('hex').slice(0, 20); }

export function compareChecks(pages, previous, now = new Date()) {
  const oldFindings = new Map((previous?.findings || []).filter(f => f.state !== 'resolved' && f.check_type !== 'title_changed').map(f => [f.id, f]));
  const oldPages = new Map((previous?.pages || []).map(p => [p.url, p]));
  const currentFindings = [], changes = [], checkedUrls = new Set(), observedIds = new Set();
  const push = (page, kind, severity, description) => {
    const id = findingId(page.url, kind), old = oldFindings.get(id);
    observedIds.add(id);
    currentFindings.push({ id, severity, state: old ? 'ongoing' : 'new', check_type: kind,
      page_url: page.url, description, first_seen: old?.first_seen || now.toISOString(),
      last_seen: now.toISOString(), evidence_ids: ['check-' + createHash('sha256').update(page.url).digest('hex').slice(0, 16)] });
  };
  for (const page of pages) {
    if (page.check_status !== 'ok') {
      push(page, 'fetch_error', 'medium', '本次未能完成页面检查；不能据此判断页面已删除或旧问题已修复。');
      continue;
    }
    if (page.status_code >= 400) {
      push(page, 'http_status', page.status_code >= 500 ? 'high' : 'medium', '页面本次返回 HTTP ' + page.status_code + '，需要复核服务与重定向。');
      continue; // Other checks were not observed; do not resolve old metadata findings.
    }
    if (page.status_code < 200 || page.status_code >= 300) { push(page, 'http_status', 'medium', '未取得成功的 HTML 响应。'); continue; }
    checkedUrls.add(page.url);
    if (page.noindex) push(page, 'noindex', 'high', 'HTML 或响应头出现 noindex 指令；请确认是否为预期设置。');
    if (!page.title) push(page, 'missing_title', 'medium', '静态 HTML 缺少非空 title。');
    if (!page.description) push(page, 'missing_description', 'low', '静态 HTML 缺少 meta description。');
    if (!page.canonical) push(page, 'missing_canonical', 'low', '静态 HTML 未观察到 canonical 声明。');
    if (!(page.h1?.length)) push(page, 'missing_h1', 'low', '静态 HTML 未观察到 H1。');
    if (page.canonical) {
      try {
        const canonical = new URL(page.canonical), final = new URL(page.final_url);
        if (canonical.origin !== final.origin || canonical.pathname.replace(/\/$/, '') !== final.pathname.replace(/\/$/, ''))
          push(page, 'canonical_target', 'medium', 'canonical 指向与当前落地页不同的地址；需确认规范化意图。');
      } catch { push(page, 'canonical_invalid', 'medium', 'canonical 不是有效 URL。'); }
    }
    const old = oldPages.get(page.url);
    if (old?.check_status === 'ok') {
      for (const field of ['title', 'description', 'canonical', 'robots']) {
        if (old[field] !== undefined && page[field] !== old[field]) changes.push({
          page_url: page.url, field, before: old[field], after: page[field],
          evidence_ids: ['check-' + createHash('sha256').update(page.url).digest('hex').slice(0, 16)]
        });
      }
    }
  }
  for (const old of oldFindings.values()) {
    if (observedIds.has(old.id)) continue;
    const resolved = checkedUrls.has(old.page_url);
    currentFindings.push({ ...old, state: resolved ? 'resolved' : 'unverified',
      // Preserve old evidence as historical: never attach a missing current ID.
      evidence_ids: pages.some(page => page.url === old.page_url) ? ['check-' + createHash('sha256').update(old.page_url).digest('hex').slice(0, 16)] : [],
      last_seen: old.last_seen, description: old.description,
      status_note: resolved ? '本次成功检查中已不再观察到。' : '本次检查未覆盖，状态待确认。' });
  }
  return { checked_pages: pages.filter(p => p.check_status === 'ok').length,
    attempted_pages: pages.length, new_count: currentFindings.filter(f => f.state === 'new').length,
    ongoing_count: currentFindings.filter(f => f.state === 'ongoing').length,
    resolved_count: currentFindings.filter(f => f.state === 'resolved').length,
    pages, findings: currentFindings, changes };
}

export function selectPages(config, seo) {
  const result = [...config.pages];
  const movers = seo?.movers?.['7d']?.pages || [];
  for (const row of movers) { const url = safeUrl(row.key, config.allowed_hosts); if (url) result.push(url); }
  return [...new Set(result.map(u => safeUrl(u, config.allowed_hosts)).filter(Boolean))].slice(0, config.page_limit);
}

export async function collectTechnical(config, seo, previous, options = {}) {
  const now = options.now || new Date(), urls = selectPages(config, seo), pages = [];
  // Two requests at a time; no deep crawl and no session or analytics credential.
  for (let index = 0; index < urls.length; index += 2) pages.push(...await Promise.all(urls.slice(index, index + 2).map(url => fetchPage(url, config, { ...options, now }))));
  const site_checks = compareChecks(pages, previous, now);
  const evidence = pages.map(page => ({ id: 'check-' + createHash('sha256').update(page.url).digest('hex').slice(0, 16),
    source_id: 'pages', title: '重点页面静态 HTML 检查', observed_at: now.toISOString(), url: page.url, details: page }));
  const errors = pages.filter(p => p.check_status !== 'ok').length;
  return { site_checks, evidence, source: { id: 'pages', status: errors ? 'partial' : 'ok',
    collected_at: now.toISOString(), data_through: null, data_timezone: null,
    reason: errors ? '部分重点页未检查成功；不会将其视为删除或已修复。' : '仅检查静态 HTML、HTTP 和声明，不等同于 Google 收录或渲染结果。' } };
}
