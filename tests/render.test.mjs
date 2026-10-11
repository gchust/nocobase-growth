import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, renderMarkdown } from '../src/render.mjs';

function metric(current, previous, kind = 'count') {
  return {
    current, previous,
    absolute_change: current === null || previous === null ? null : current - previous,
    relative_change: previous === null || current === null || previous === 0 || kind === 'rate'
      ? null : (current - previous) / previous,
  };
}

function fixture() {
  const comparisons = Object.fromEntries(['7d', '28d'].map((window) => [window, {
    current_period: { start_date: window === '7d' ? '2026-10-03' : '2026-09-12', end_date: '2026-10-09' },
    previous_period: { start_date: window === '7d' ? '2026-09-26' : '2026-08-15', end_date: window === '7d' ? '2026-10-02' : '2026-09-11' },
    metrics: {
      clicks: metric(120, 100), impressions: metric(3000, 2500),
      ctr: metric(0.04, 0.03, 'rate'), position: metric(10, 12),
    },
  }]));
  return {
    schema_version: 1,
    site: { id: 'nocobase', name: 'NocoBase', url: 'https://nocobase.com', timezone: 'Asia/Shanghai' },
    generated_at: '2026-10-11T01:17:00Z', report_date: '2026-10-11', report_status: 'complete',
    run: { id: 123, attempt: 1, url: 'https://github.com/owner/private-report/actions/runs/123', code_sha: 'abc123', model: 'deepseek-v4.1-flash' },
    sources: [{ id: 'gsc', status: 'ok', collected_at: '2026-10-11T01:16:00Z', data_through: '2026-10-09', data_timezone: 'America/Los_Angeles', reason: null }],
    seo: {
      data_through: '2026-10-09', data_timezone: 'America/Los_Angeles',
      daily: [
        { date: '2026-10-04', clicks: 0, impressions: 0, ctr: 0, position: null },
        { date: '2026-10-05', clicks: 5, impressions: 100, ctr: 0.05, position: 10 },
        { date: '2026-10-07', clicks: 8, impressions: 120, ctr: 0.06667, position: 9 },
        { date: '2026-10-08', clicks: null, impressions: null, ctr: null, position: null },
        { date: '2026-10-09', clicks: 2, impressions: 50, ctr: 0.04, position: 12 },
      ],
      comparisons,
      movers: {
        '7d': {
          pages: [{ key: 'https://nocobase.com/en/blog/example', current: { clicks: 5 }, previous: { clicks: 0 }, click_change: 5, evidence_ids: ['page-1'] }],
          queries: [{ key: 'nocobase low code', current: null, previous: { clicks: 3 }, click_change: null, evidence_ids: ['page-1'] }],
        },
        '28d': { pages: [], queries: [] },
      },
      coverage: { query_rows: 100 }, notes: [],
    },
    analytics: null,
    site_checks: { checked_pages: 12, new_count: 1, ongoing_count: 0, resolved_count: 0, pages: [], findings: [{ id: 'canonical-1', severity: 'high', state: 'new', check_type: 'canonical', page_url: 'https://nocobase.com/en/blog/example', description: 'Canonical 地址需要核对。', first_seen: '2026-10-11', last_seen: '2026-10-11', evidence_ids: ['page-1'] }] },
    evidence: [{ id: 'page-1', source_id: 'gsc', title: '页面查询对比', observed_at: '2026-10-11T01:16:00Z', url: 'https://search.google.com/search-console/', details: { clicks: 0, note: '原始数据摘录' } }],
    insights: {
      summary: '搜索点击上升；一处页面设置需要核对。',
      hypotheses: [{ title: '查询需求可能变化', explanation: '尚需核对同一组查询。', confidence: 'medium', evidence_ids: ['page-1'], verification: '比较同组查询的曝光与位置。' }],
      actions: [{ priority: 1, title: '核对 canonical', target_urls: ['https://nocobase.com/en/blog/example'], reason: '检查潜在的索引影响。', effort: 'small', acceptance: '与页面实际定位一致。', evidence_ids: ['page-1'] }],
      limitations: [],
    },
    history: { index_url: 'https://github.com/owner/private-report', previous_report_url: 'https://github.com/owner/private-report/blob/history/previous.html' },
  };
}

function chart(html, name) {
  const match = html.match(new RegExp(`<svg data-chart="${name}"[\\s\\S]*?<\\/svg>`));
  assert.ok(match, `${name} SVG should be rendered`);
  return match[0];
}

test('renders both windows, source cutoff, local run time, and private report links without dependencies', () => {
  const html = renderReport(fixture());
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /最近 7 天/);
  assert.match(html, /最近 28 天/);
  assert.match(html, /2026-10-03 — 2026-10-09/);
  assert.match(html, /2026-08-15 — 2026-09-11/);
  assert.match(html, /2026\/10\/11 09:17 · Asia\/Shanghai/);
  assert.match(html, /搜索数据截至 <strong>2026-10-09/);
  assert.match(html, /分析模型 <strong>deepseek-v4\.1-flash/);
  assert.match(html, /private-report\/blob\/history\/previous.html/);
  assert.doesNotMatch(html, /<(?:script|iframe|img)\b|<link\b|@import|\burl\(/i);
  assert.match(html, /<details class="evidence-item"/);
});

test('escapes untrusted text throughout model, page, metadata, and evidence fields', () => {
  const report = fixture();
  const payload = '</style><script>alert("owned")</script><img src=x onerror=alert(1)> & \'test\'';
  report.site.name = payload;
  report.insights.summary = payload;
  report.insights.hypotheses[0].title = payload;
  report.insights.hypotheses[0].explanation = payload;
  report.insights.hypotheses[0].verification = payload;
  report.insights.actions[0].title = payload;
  report.insights.actions[0].reason = payload;
  report.insights.actions[0].acceptance = payload;
  report.insights.limitations = [payload];
  report.site_checks.findings[0].description = payload;
  report.site_checks.findings[0].check_type = payload;
  report.seo.movers['7d'].queries[0].key = payload;
  report.sources[0].reason = payload;
  report.run.code_sha = payload;
  report.evidence[0].title = payload;
  report.evidence[0].details = { untrusted: payload };
  const html = renderReport(report);
  assert.doesNotMatch(html, /<script\b|<img\b/i);
  assert.equal((html.match(/<\/style>/g) || []).length, 1);
  assert.match(html, /&lt;script&gt;alert\(&quot;owned&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&amp; &#39;test&#39;/);
});

test('permits only absolute HTTP(S) links and safely encodes their attributes', () => {
  const report = fixture();
  report.site.url = 'javascript:alert(1)';
  report.run.url = 'data:text/html,<script>alert(1)</script>';
  report.history.index_url = '//attacker.example/path';
  report.history.previous_report_url = 'file:///etc/passwd';
  report.evidence[0].url = 'https:\n//attacker.example';
  report.insights.actions[0].target_urls = ['vbscript:msgbox(1)', 'https://example.test/?x=1&y="quoted"'];
  report.site_checks.findings[0].page_url = 'javascript:alert(1)';
  report.seo.movers['7d'].pages[0].key = 'data:text/html,<img src=x>';
  const html = renderReport(report);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length > 0);
  assert.ok(hrefs.every((href) => href.startsWith('#evidence-') || /^https?:\/\//.test(href)));
  assert.match(html, /href="https:\/\/example.test\/\?x=1&amp;y=%22quoted%22"/);
  assert.doesNotMatch(html, /href="(?:javascript|data|vbscript|file):/);
  assert.doesNotMatch(html, /<img\b|<script\b/);
});

test('represents absent GSC as missing evidence rather than fabricated zeros or a score', () => {
  const report = fixture();
  report.seo = null;
  report.report_status = 'limited';
  report.sources[0].status = 'not_configured';
  report.sources[0].data_through = null;
  report.sources[0].reason = '尚未提供访问凭据';
  report.insights.summary = '';
  const html = renderReport(report);
  assert.match(html, /暂不能判断搜索增长/);
  assert.match(html, /页面检查可以发现技术问题，但不能替代真实搜索效果数据/);
  assert.match(html, /尚未提供访问凭据/);
  assert.match(html, /已检查页面/);
  assert.doesNotMatch(html, /<article class="metric-card">/);
  assert.doesNotMatch(html, /data-chart=|SEO 评分|SEO 分数|NaN|Infinity/);
});

test('handles zero baselines in both windows without fabricated percentages', () => {
  const report = fixture();
  for (const window of Object.values(report.seo.comparisons)) {
    window.metrics.clicks = metric(0, 0);
    window.metrics.impressions = metric(15, 0);
  }
  const html = renderReport(report);
  assert.equal((html.match(/增加 15 · 无可比基数/g) || []).length, 2);
  assert.ok((html.match(/>持平</g) || []).length >= 2);
  assert.doesNotMatch(html, /NaN|Infinity|∞/);
});

test('formats rates as percentage points and lower search positions as improvements', () => {
  const report = fixture();
  report.seo.comparisons['28d'].metrics.position = metric(12, 10);
  const html = renderReport(report);
  assert.match(html, /\+20\.0%/);
  assert.match(html, /\+1\.00 个百分点/);
  assert.match(html, /class="metric-change positive">改善 2\.00 位/);
  assert.match(html, /class="metric-change negative">下降 2\.00 位/);
});

test('creates separate SVG segments for omitted dates and explicit nulls, preserving actual zero', () => {
  const html = renderReport(fixture());
  for (const name of ['clicks', 'impressions']) {
    const svg = chart(html, name);
    assert.match(svg, /data-segments="3" data-points="4"/);
    assert.equal((svg.match(/class="trend-line"/g) || []).length, 1);
    assert.match(svg, /data-start-date="2026-10-04" data-end-date="2026-10-05"/);
    assert.equal((svg.match(/class="trend-point"/g) || []).length, 4);
    assert.match(svg, /2026-10-04 · 搜索(?:点击|曝光) 0/);
    assert.doesNotMatch(svg, /NaN|Infinity/);
    assert.match(svg, /52 日缺失/);
  }
});

test('zero-only chart stays finite and dates newer than the source cutoff are excluded', () => {
  const report = fixture();
  report.seo.daily = [
    { date: '2026-10-08', clicks: 0, impressions: 0 },
    { date: '2026-10-09', clicks: 0, impressions: 0 },
    { date: '2026-10-10', clicks: 999999, impressions: 999999 },
    { date: '2026-02-30', clicks: 999999, impressions: 999999 },
  ];
  const html = renderReport(report);
  const svg = chart(html, 'clicks');
  assert.match(svg, /data-segments="1" data-points="2"/);
  assert.doesNotMatch(svg, /NaN|Infinity|999999|2026-10-10/);
});

test('resolves evidence links to generated safe anchors and omits unknown references', () => {
  const report = fixture();
  const hostileId = 'x" onclick="alert(1)';
  report.evidence[0].id = hostileId;
  report.insights.hypotheses[0].evidence_ids = [hostileId, hostileId, 'missing'];
  report.insights.actions[0].evidence_ids = ['missing'];
  const html = renderReport(report);
  assert.match(html, /href="#evidence-1"/);
  assert.match(html, /id="evidence-1"/);
  assert.doesNotMatch(html, /onclick=|href="#missing"/);
  assert.equal((html.match(/href="#evidence-1"/g) || []).length, 1);
});

test('supports optional analytics, missing comparative values, and valid empty reports', () => {
  const report = fixture();
  report.analytics = { comparisons: { '7d': { ...report.seo.comparisons['7d'], metrics: { sessions: metric(20, null), active_users: metric(0, 0), key_events: metric(null, null) } } } };
  const html = renderReport(report);
  assert.match(html, /站内表现/);
  assert.match(html, /关键事件/);
  assert.match(html, /缺少对比数据/);
  assert.doesNotThrow(() => renderReport({ schema_version: 1, report_status: 'limited', site: {} }));
  assert.throws(() => renderReport({ schema_version: 2 }), /schema_version/);
  assert.throws(() => renderReport(null), /schema_version/);
});

test('shows attempted checks, unverified state, and ISO first/last observations accurately', () => {
  const report = fixture();
  report.site_checks.attempted_pages = 15;
  report.site_checks.findings[0].state = 'unverified';
  report.site_checks.findings[0].first_seen = '2026-10-01T12:15:00.000Z';
  report.site_checks.findings[0].last_seen = '2026-10-08T12:15:00.000Z';
  const html = renderReport(report);
  assert.match(html, /尝试访问 15 页/);
  assert.match(html, /待核验/);
  assert.match(html, /首次 2026-10-01 · 最近 2026-10-08/);
});

test('Markdown exposes report and source dates, both comparison windows, safe evidence, and history', () => {
  const result = renderMarkdown(fixture());
  assert.match(result, /^# NocoBase 增长日报/);
  assert.match(result, /生成时间：2026\/10\/11 09:17 · Asia\/Shanghai/);
  assert.ok(result.includes('搜索数据截至：2026\\-10\\-09'));
  assert.ok(result.includes('deepseek\\-v4\\.1\\-flash'));
  assert.match(result, /\| 最近 7 天 \| 前 7 天 \| 变化 \| 最近 28 天 \| 前 28 天/);
  assert.ok(result.includes('2026\\-08\\-15 — 2026\\-09\\-11'));
  assert.ok(result.includes('\\+1\\.00 个百分点'));
  assert.ok(result.includes('[证据 1](https://search.google.com/search-console/)'));
  assert.match(result, /\[下载 HTML 报告\]\(report\.html\)/);
  assert.match(result, /\[结构化数据\]\(report\.json\)/);
  assert.match(result, /\[上次报告\]\(https:\/\/github.com\/owner\/private-report/);
  assert.doesNotMatch(result, /<\/?[a-z][^>]*>/i);
});

test('Markdown treats model text as literal text and cannot inject images, HTML, headings or table rows', () => {
  const report = fixture();
  const payload = '![tracking](https://attacker.example/pixel) <img src="x" onerror="alert(1)">\n# injected\n[bad](javascript:alert(1))\n| stolen | cell |\n```html\n<script>alert(1)</script>\n```';
  report.site.name = payload;
  report.insights.summary = payload;
  report.insights.actions[0].title = payload;
  report.insights.actions[0].reason = payload;
  report.insights.actions[0].acceptance = payload;
  report.insights.hypotheses[0].verification = payload;
  report.sources[0].reason = payload;
  report.evidence[0].title = payload;
  report.site_checks.findings[0].description = payload;
  const result = renderMarkdown(report);
  assert.ok(result.includes('\\!\\[tracking\\]\\(https://attacker\\.example/pixel\\)'));
  assert.ok(result.includes('&lt;img src="x" onerror="alert\\(1\\)"&gt;'));
  assert.ok(result.includes('\\# injected'));
  assert.ok(result.includes('\\| stolen \\| cell \\|'));
  assert.ok(result.includes('\\`\\`\\`html'));
  assert.doesNotMatch(result, /<\/?(?:img|script|iframe)\b/i);
  assert.doesNotMatch(result, /(?<!\\)!\[|\n# injected|\n\| stolen|\n```/);
});

test('Markdown links reject unsafe protocols and encode destination delimiters', () => {
  const report = fixture();
  report.history.index_url = 'javascript:alert(1)';
  report.run.url = 'data:text/html,<img src=x>';
  report.evidence[0].url = 'file:///tmp/local';
  report.insights.actions[0].target_urls = ['https://example.test/a(b)|c?x="quote"', 'javascript:alert(1)', '//attacker.example'];
  const result = renderMarkdown(report);
  assert.ok(result.includes('(https://example.test/a%28b%29%7Cc?x=%22quote%22)'));
  assert.doesNotMatch(result, /(?<!\\)\]\((?:javascript|data|file):|(?<!\\)\]\(\/\//i);
  assert.doesNotMatch(result, /\[证据 1\]\(file:/);
});

test('Markdown preserves zero-baseline and missing-source semantics without fictitious growth', () => {
  const report = fixture();
  for (const comparison of Object.values(report.seo.comparisons)) {
    comparison.metrics.clicks = metric(15, 0);
  }
  const result = renderMarkdown(report);
  assert.equal((result.match(/增加 15 · 无可比基数/g) || []).length, 2);
  report.seo = null;
  const missing = renderMarkdown(report);
  assert.match(missing, /暂不能判断搜索增长/);
  assert.doesNotMatch(missing, /\| 指标 \||NaN|Infinity|SEO 评分/);
  assert.doesNotThrow(() => renderMarkdown({ schema_version: 1 }));
  assert.throws(() => renderMarkdown({ schema_version: 2 }), /schema_version/);
  assert.throws(() => renderMarkdown(null), /schema_version/);
});

test('shows page field changes as safely escaped observations and preserves separate status notes', () => {
  const report = fixture();
  report.site_checks.changes = [{
    page_url: 'https://nocobase.com/en/blog/example', field: 'title',
    before: '<script>alert(1)</script>', after: '![tracking](https://attacker.example/pixel)', evidence_ids: ['page-1'],
  }, { page_url: 'javascript:alert(1)', field: 'canonical', before: null, after: '', evidence_ids: [] }];
  report.site_checks.findings[0].status_note = '本次检查未覆盖，状态待确认。 <img src=x>';
  const html = renderReport(report);
  assert.match(html, /页面内容与声明变化/);
  assert.match(html, /变化本身不代表 SEO 改善或恶化/);
  assert.match(html, /页面标题/);
  assert.match(html, /本次检查未覆盖，状态待确认。 &lt;img src=x&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /class="change-value">—<\/td><td class="change-value">（空）/);
  assert.doesNotMatch(html, /<script\b|<img\b|href="javascript:/i);
  const result = renderMarkdown(report);
  assert.match(result, /另记录 2 处页面内容与声明变化/);
  assert.match(result, /本次检查未覆盖，状态待确认。 &lt;img src=x&gt;/);
  assert.doesNotMatch(result, /<img\b|(?<!\\)!\[/);
});
