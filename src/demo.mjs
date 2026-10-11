import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareTotals, comparisonPeriods, shiftDate } from './metrics.mjs';
import { renderReport, renderMarkdown } from './render.mjs';

// Generated fixtures only. None of these values describe actual NocoBase traffic.
export function makeDemoReport(config) {
  const end = '2026-10-08';
  const daily = Array.from({ length: 90 }, (_, i) => {
    const impressions = 12000 + i * 20 + (i % 7) * 180;
    const clicks = 370 + i * 3 + (i % 7) * 8;
    return { date: shiftDate(end, i - 89), clicks, impressions, ctr: clicks / impressions, position: 15 - i / 40 };
  });
  const totals = period => {
    const rows = daily.filter(row => row.date >= period.start_date && row.date <= period.end_date);
    const clicks = rows.reduce((n, r) => n + r.clicks, 0), impressions = rows.reduce((n, r) => n + r.impressions, 0);
    return { clicks, impressions, ctr: clicks / impressions, position: rows.reduce((n, r) => n + r.position * r.impressions, 0) / impressions };
  };
  const comparisons = Object.fromEntries([7, 28].map(length => {
    const periods = comparisonPeriods(end, length);
    return [length + 'd', compareTotals(periods, totals(periods.current_period), totals(periods.previous_period), ['clicks', 'impressions', 'ctr', 'position'])];
  }));
  return {
    schema_version: 1, is_demo: true,
    site: { id: config.id, name: config.name + ' · 合成数据演示', url: config.url, timezone: config.timezone },
    generated_at: '2026-10-11T01:17:00.000Z', report_date: '2026-10-11', report_status: 'limited',
    run: { id: 'synthetic-demo', attempt: 1, code_sha: '0'.repeat(40), url: null, model: 'synthetic-fixture', claude_code_version: null },
    sources: [
      { id: 'gsc', status: 'ok', data_through: end, data_timezone: 'America/Los_Angeles', collected_at: '2026-10-11T01:17:00.000Z', reason: '合成测试数据；未访问 Google。' },
      { id: 'ga4', status: 'not_configured', data_through: null, data_timezone: null, collected_at: '2026-10-11T01:17:00.000Z', reason: '此演示未包含转化数据。' },
      { id: 'pages', status: 'ok', data_through: null, data_timezone: null, collected_at: '2026-10-11T01:17:00.000Z', reason: '合成页面状态；未请求真实页面。' }
    ],
    seo: { data_through: end, data_timezone: 'America/Los_Angeles', daily, comparisons,
      movers: { '7d': { pages: [], queries: [] }, '28d': { pages: [], queries: [] } },
      coverage: { type: 'synthetic' }, notes: ['所有数字仅用于验证布局和计算，不能用于业务判断。'] },
    analytics: null,
    site_checks: { attempted_pages: 1, checked_pages: 1, new_count: 1, ongoing_count: 0, resolved_count: 0, pages: [],
      findings: [{ id: 'demo-title', severity: 'low', state: 'new', check_type: 'title_changed', page_url: config.url,
        description: '演示：标题变化需要结合后续效果验证。', first_seen: '2026-10-11T01:17:00.000Z', last_seen: '2026-10-11T01:17:00.000Z', evidence_ids: ['synthetic-page'] }] },
    evidence: [
      { id: 'synthetic-gsc', source_id: 'gsc', title: '合成搜索指标', observed_at: '2026-10-11T01:17:00.000Z', url: null, details: { source: 'fixture', real_data: false } },
      { id: 'synthetic-page', source_id: 'pages', title: '合成页面检查', observed_at: '2026-10-11T01:17:00.000Z', url: config.url, details: { source: 'fixture', real_data: false } }
    ],
    insights: {
      summary: '这是合成数据演示，所有数字和结论均为测试内容，不代表 nocobase.com 的真实增长。正式运行会使用经过授权的 Google 数据，并由指定模型生成解读。',
      hypotheses: [{ title: '演示：搜索表现可能与页面变化有关', explanation: '这条假设只用于检查证据、置信度和验证步骤的展示。', confidence: 'low', evidence_ids: ['synthetic-gsc', 'synthetic-page'], verification: '正式报告需对齐发布日与实际 GSC 数据，并检查同一组页面和查询词。' }],
      actions: [{ priority: 1, title: '接通真实 Google 数据并验证首份报告', target_urls: [config.url], reason: '先确认站点权限与数据口径，才能评估实际效果。', effort: 'small', acceptance: '正式报告注明真实数据截止日，区间总量与 Search Console 一致。', evidence_ids: ['synthetic-gsc'] }],
      limitations: ['此示例未调用 Google、Claude Code 或 DeepSeek。', '未接入 GA4，不能判断自然搜索带来的转化。']
    },
    history: { index_url: null, previous_report_url: null }
  };
}

export async function writeDemo(config, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = makeDemoReport(config);
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(directory, 'report.html'), renderReport(report), { mode: 0o600 });
  await writeFile(join(directory, 'report.md'), renderMarkdown(report), { mode: 0o600 });
  return report;
}
