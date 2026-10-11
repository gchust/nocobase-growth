import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFacts } from '../src/validate.mjs';
import { renderReport, renderMarkdown } from '../src/render.mjs';
import { makeDemoReport } from '../src/demo.mjs';

function inspection() {
  const url = 'https://nocobase.com/en/';
  const observed = '2026-10-11T01:17:00.000Z';
  const page = { url, check_status: 'ok', status_code: 200, title: 'NocoBase', canonical: url };
  return {
    schema_version: 1,
    site: { id: 'nocobase', name: 'NocoBase', url, timezone: 'Asia/Shanghai' },
    report_date: '2026-10-11', generated_at: observed, report_status: 'limited',
    run: { id: 'synthetic-inspection', attempt: 1, code_sha: '0'.repeat(40), model: 'synthetic-fixture' },
    seo: null, analytics: null,
    sources: [
      ...['gsc', 'ga4'].map(id => ({ id, status: 'not_configured', reason: '未配置 Google 访问凭据。',
        collected_at: observed, data_through: null, data_timezone: null })),
      { id: 'pages', status: 'ok', reason: '合成页面采集，仅用于测试。', collected_at: observed, data_through: null },
    ],
    site_checks: {
      pages: [page], checked_pages: 1, attempted_pages: 1, new_count: 1, ongoing_count: 0, resolved_count: 0,
      findings: [{ id: 'synthetic-title', check_type: 'title', severity: 'low', state: 'new',
        description: '页面标题需要核对。', page_url: url, first_seen: observed, last_seen: observed, evidence_ids: ['page-1'] }],
      changes: [{ page_url: url, field: 'title', before: 'Old title', after: 'NocoBase', evidence_ids: ['page-1'] }],
    },
    evidence: [{ id: 'page-1', source_id: 'pages', title: '合成页面巡检证据', url, observed_at: observed, details: page }],
    insights: {
      summary: '页面标题发生变化，需要结合页面定位核对。', hypotheses: [],
      actions: [{ priority: 1, title: '核对页面标题', reason: '确认标题与页面定位一致。', target_urls: [url],
        effort: 'small', acceptance: '标题准确描述页面内容。', evidence_ids: ['page-1'] }],
      limitations: ['Google 搜索效果尚未接入。'],
    },
  };
}

test('explicitly unconfigured Google sources permit a limited report backed by page observations', () => {
  const facts = inspection();
  assert.equal(validateFacts(facts), facts);
  const before = structuredClone(facts);
  renderReport(facts);
  renderMarkdown(facts);
  assert.deepEqual(facts, before);
});

test('missing, failed, duplicate or allegedly successful GSC sources cannot masquerade as page-only mode', () => {
  const mutations = [
    facts => { facts.sources = facts.sources.filter(source => source.id !== 'gsc'); },
    facts => { facts.sources[0].status = 'error'; },
    facts => { facts.sources[0].status = 'ok'; },
    facts => { facts.sources[0].status = 'partial'; },
    facts => { facts.sources[0].reason = '  '; },
    facts => { facts.sources[0].data_through = '2026-10-09'; },
    facts => { facts.sources.push({ ...facts.sources[0] }); },
  ];
  for (const mutate of mutations) {
    const facts = inspection(); mutate(facts);
    assert.throws(() => validateFacts(facts), /REPORT_GSC_UNAVAILABLE/);
  }
});

test('page-only mode rejects missing nulls, complete status and inconsistent GA4 metadata', () => {
  const mutations = [
    facts => { delete facts.seo; },
    facts => { facts.seo = { daily: [] }; },
    facts => { facts.report_status = 'complete'; },
    facts => { delete facts.analytics; },
    facts => { facts.analytics = { comparisons: {} }; },
    facts => { facts.sources = facts.sources.filter(source => source.id !== 'ga4'); },
    facts => { facts.sources[1].status = 'error'; },
    facts => { facts.sources[1].reason = null; },
    facts => { facts.sources[1].data_through = '2026-10-09'; },
    facts => { facts.sources.push({ ...facts.sources[1] }); },
  ];
  for (const mutate of mutations) {
    const facts = inspection(); mutate(facts);
    assert.throws(() => validateFacts(facts), /REPORT_(?:FACTS_INVALID|GSC_UNAVAILABLE)/);
  }
});

test('page-only facts need page source records and matching evidence, and cannot reuse Google evidence', () => {
  const mutations = [
    facts => { facts.sources = facts.sources.filter(source => source.id !== 'pages'); },
    facts => { facts.sources[2].status = 'error'; },
    facts => { facts.site_checks.pages = []; },
    facts => { facts.evidence = []; },
    facts => { facts.evidence[0].url = 'https://nocobase.com/another-page'; },
    facts => { facts.evidence.push({ id: 'invented-gsc', source_id: 'gsc' }); },
    facts => { facts.evidence.push({ id: 'invented-ga4', source_id: 'ga4' }); },
  ];
  for (const mutate of mutations) {
    const facts = inspection(); mutate(facts);
    assert.throws(() => validateFacts(facts), /REPORT_(?:PAGE_EVIDENCE_INVALID|EVIDENCE_INVALID)/);
  }
  const failedPage = inspection();
  failedPage.sources[2].status = 'partial';
  failedPage.site_checks.pages[0].check_status = 'error';
  failedPage.site_checks.checked_pages = 0;
  assert.equal(validateFacts(failedPage), failedPage, 'failed fetch observations remain explicitly partial');
});

test('GSC reports retain metric validation and never bypass it through not_configured status', () => {
  const facts = makeDemoReport({ id: 'synthetic', name: 'Synthetic', url: 'https://nocobase.com/', timezone: 'Asia/Shanghai' });
  assert.equal(validateFacts(facts), facts);
  facts.sources[0].status = 'partial';
  assert.equal(validateFacts(facts), facts);
  facts.seo.comparisons['7d'].metrics.clicks.current = Infinity;
  assert.throws(() => validateFacts(facts), /REPORT_METRICS_INVALID/);
  facts.sources[0].status = 'not_configured';
  assert.throws(() => validateFacts(facts), /REPORT_GSC_UNAVAILABLE/);
});

test('HTML labels page inspection, omits search trends and keeps observations, changes, advice and evidence', () => {
  const html = renderReport(validateFacts(inspection()));
  assert.match(html, /<title>NocoBase 页面 SEO 巡检 · 2026-10-11<\/title>/);
  assert.match(html, /Google 搜索效果尚未接入/);
  assert.match(html, /暂不能判断搜索增长/);
  assert.match(html, /页面检查可以发现技术问题，但不能替代真实搜索效果数据/);
  for (const text of ['页面标题需要核对。', '页面内容与声明变化', 'Old title', '核对页面标题', '合成页面巡检证据', '数据受限']) assert.ok(html.includes(text));
  assert.match(html, /href="#evidence-1"/);
  assert.doesNotMatch(html, /增长日报|搜索数据截至|<article class="metric-card">|data-chart=|class="mover-table"|查看每日数据|NaN|Infinity|>null</);
});

test('Markdown labels page inspection without comparison tables, preserving page evidence and AI advice', () => {
  const result = renderMarkdown(validateFacts(inspection()));
  assert.match(result, /^# NocoBase 页面 SEO 巡检 · 2026\\-10\\-11/);
  assert.match(result, /Google 搜索效果尚未接入/);
  assert.match(result, /暂不能判断搜索增长/);
  for (const text of ['页面标题需要核对。', '1 处页面内容与声明变化', '核对页面标题', '合成页面巡检证据', '数据受限']) assert.ok(result.includes(text));
  assert.match(result, /\[证据 1\]\(https:\/\/nocobase.com\/en\/\)/);
  assert.doesNotMatch(result, /增长日报|搜索数据截至|\| 指标 \||前 7 天|前 28 天|点击上升|排名提升|NaN|Infinity/);
});

test('unconfigured source reasons remain escaped in both report formats', () => {
  const facts = inspection();
  facts.sources[0].reason = '<script>bad()</script>\n![image](https://attacker.example/x)';
  const html = renderReport(validateFacts(facts));
  const md = renderMarkdown(facts);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script\b/);
  assert.doesNotMatch(md, /<script\b|(?<!\\)!\[/);
});
