const NUMBER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const DAY_MS = 86_400_000;
const SOURCE_NAMES = {
  gsc: 'Google Search Console',
  ga4: 'Google Analytics 4',
  pages: '重点页面检查',
  site: '重点页面检查',
  site_checks: '重点页面检查',
};
const SOURCE_STATES = {
  ok: ['已获取', 'positive'],
  partial: ['部分数据', 'warning'],
  not_configured: ['尚未接入', 'neutral'],
  error: ['读取失败', 'negative'],
};
const SEO_METRICS = [
  { key: 'clicks', label: '搜索点击', kind: 'count', note: '来自搜索结果的点击' },
  { key: 'impressions', label: '搜索曝光', kind: 'count', note: '在搜索结果中出现的次数' },
  { key: 'ctr', label: '点击率', kind: 'rate', note: '点击 ÷ 曝光；差值使用百分点' },
  { key: 'position', label: '平均位置', kind: 'position', note: '数值越小越靠前；受查询组合影响' },
];
const ANALYTICS_METRICS = [
  { key: 'sessions', label: '会话数', kind: 'count' },
  { key: 'active_users', label: '活跃用户', kind: 'count' },
  { key: 'key_events', label: '关键事件', kind: 'count' },
];

function string(value) {
  return typeof value === 'string' ? value : '';
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function escape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeUrl(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function link(url, label, className = '') {
  const href = safeUrl(url);
  const text = escape(label);
  return href
    ? `<a href="${escape(href)}" class="${className}" target="_blank" rel="noopener noreferrer">${text}</a>`
    : `<span class="${className}">${text}</span>`;
}

function optionalLink(url, label, className = '') {
  return safeUrl(url) ? link(url, label, className) : '';
}

function number(value, precision = 0) {
  if (!finite(value)) return '—';
  return precision === 0 ? NUMBER.format(value) : value.toLocaleString('zh-CN', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}

function metricValue(value, definition) {
  if (!finite(value)) return '—';
  if (definition.kind === 'rate') return `${number(value * 100, 2)}%`;
  return number(value, definition.kind === 'position' ? 2 : 0);
}

function change(metric, definition) {
  if (!record(metric) || !finite(metric.current) || !finite(metric.previous)) {
    return { text: '缺少对比数据', tone: 'neutral' };
  }
  if (metric.current === metric.previous) return { text: '持平', tone: 'neutral' };
  const delta = metric.absolute_change;
  if (!finite(delta)) return { text: '变化未提供', tone: 'neutral' };
  const improvement = definition.kind === 'position' ? -delta : delta;
  const tone = improvement > 0 ? 'positive' : improvement < 0 ? 'negative' : 'neutral';
  if (definition.kind === 'rate') {
    return { text: `${delta > 0 ? '+' : ''}${number(delta * 100, 2)} 个百分点`, tone };
  }
  if (definition.kind === 'position') {
    return { text: `${delta < 0 ? '改善' : '下降'} ${number(Math.abs(delta), 2)} 位`, tone };
  }
  if (metric.previous === 0) {
    return { text: `增加 ${number(delta)} · 无可比基数`, tone };
  }
  if (!finite(metric.relative_change)) return { text: '未提供相对变化', tone: 'neutral' };
  const ratio = metric.relative_change;
  return { text: `${ratio > 0 ? '+' : ''}${number(ratio * 100, 1)}%`, tone };
}

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp : null;
}

function dateLabel(value) {
  return day(value) === null ? '未提供' : value;
}

function observedDateLabel(value) {
  if (day(value) !== null) return value;
  const timestamp = Date.parse(string(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : '未提供';
}

function periodLabel(period) {
  return record(period) && day(period.start_date) !== null && day(period.end_date) !== null
    ? `${period.start_date} — ${period.end_date}` : '期间未完整提供';
}

function timestampLabel(value, timezone = 'Asia/Shanghai') {
  const date = new Date(string(value));
  if (!Number.isFinite(date.getTime())) return '未提供';
  let zone = string(timezone) || 'Asia/Shanghai';
  let formatter;
  const options = {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  };
  try {
    formatter = new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: zone });
  } catch {
    zone = 'UTC';
    formatter = new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: zone });
  }
  return `${formatter.format(date)} · ${zone}`;
}

function json(value) {
  try {
    return escape(JSON.stringify(value, null, 2));
  } catch {
    return '内容无法序列化';
  }
}

function evidenceIndex(evidence) {
  const index = new Map();
  evidence.forEach((item, position) => {
    if (record(item) && typeof item.id === 'string' && !index.has(item.id)) {
      index.set(item.id, position + 1);
    }
  });
  return index;
}

function references(ids, index) {
  const positions = [...new Set(list(ids).map((id) => index.get(id)).filter(Boolean))];
  return positions.length
    ? `<span class="references">${positions.map((position) => `<a href="#evidence-${position}" class="reference">证据 ${position}</a>`).join('')}</span>`
    : '';
}

function renderRanges(comparisons) {
  return `<div class="periods">${['7d', '28d'].map((key) => {
    const window = comparisons?.[key];
    return `<div class="period"><strong>最近 ${key === '7d' ? '7' : '28'} 天</strong><span>${escape(periodLabel(window?.current_period))}</span><small>对比 ${escape(periodLabel(window?.previous_period))}</small></div>`;
  }).join('')}</div>`;
}

function renderMetricPeriod(metric, definition, days) {
  const delta = change(metric, definition);
  return `<div class="metric-period${days === 28 ? ' secondary' : ''}">
    <div class="metric-period-label">最近 ${days} 天</div>
    <div class="metric-value">${metricValue(metric?.current, definition)}</div>
    <div class="metric-change ${delta.tone}">${escape(delta.text)}</div>
    <div class="metric-baseline">前 ${days} 天 ${metricValue(metric?.previous, definition)}</div>
  </div>`;
}

function renderMetrics(comparisons, definitions = SEO_METRICS) {
  return `<div class="metric-grid${definitions.length === 3 ? ' three' : ''}">${definitions.map((definition) => `<article class="metric-card">
    <h3>${definition.label}</h3>
    ${renderMetricPeriod(comparisons?.['7d']?.metrics?.[definition.key], definition, 7)}
    ${renderMetricPeriod(comparisons?.['28d']?.metrics?.[definition.key], definition, 28)}
    ${definition.note ? `<p class="metric-note">${definition.note}</p>` : ''}
  </article>`).join('')}</div>`;
}

function dailySeries(seo) {
  const rows = list(seo?.daily).filter((row) => record(row) && day(row.date) !== null);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const lastDate = rows.map((row) => row.date).sort().at(-1);
  const end = day(seo?.data_through) ?? day(lastDate);
  if (end === null) return [];
  return Array.from({ length: 56 }, (_, index) => {
    const date = new Date(end - (55 - index) * DAY_MS).toISOString().slice(0, 10);
    return byDate.get(date) ?? { date, clicks: null, impressions: null, ctr: null, position: null };
  });
}

function chartNumber(value) {
  if (value >= 100_000_000) return `${number(value / 100_000_000, 1)}亿`;
  if (value >= 10_000) return `${number(value / 10_000, value >= 100_000 ? 0 : 1)}万`;
  return number(value);
}

function niceMaximum(value) {
  if (value <= 1) return 1;
  const scale = 10 ** Math.floor(Math.log10(value));
  const unit = value / scale;
  const result = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * scale;
  return Number.isFinite(result) ? result : value;
}

function renderChart(series, key, label) {
  const width = 920;
  const height = 242;
  const left = 62;
  const right = width - 22;
  const top = 22;
  const bottom = height - 40;
  const valid = series.filter((row) => finite(row[key]) && row[key] >= 0);
  if (!valid.length) return `<article class="chart-card"><h3>${label}</h3><p class="empty chart-empty">尚无可绘制的日数据。</p></article>`;
  const maximum = niceMaximum(Math.max(...valid.map((row) => row[key])));
  const x = (index) => left + (index / Math.max(series.length - 1, 1)) * (right - left);
  const y = (value) => bottom - (value / maximum) * (bottom - top);
  const coordinate = (value) => value.toFixed(2);
  const segments = [];
  let segment = [];
  series.forEach((row, index) => {
    if (finite(row[key]) && row[key] >= 0) {
      segment.push({ row, x: x(index), y: y(row[key]) });
    } else if (segment.length) {
      segments.push(segment);
      segment = [];
    }
  });
  if (segment.length) segments.push(segment);
  const lines = segments.filter((points) => points.length > 1).map((points) => {
    const first = points[0];
    const last = points.at(-1);
    const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${coordinate(point.x)} ${coordinate(point.y)}`).join(' ');
    return `<path class="trend-area" d="${line} L ${coordinate(last.x)} ${bottom} L ${coordinate(first.x)} ${bottom} Z"/>
      <path class="trend-line" data-start-date="${first.row.date}" data-end-date="${last.row.date}" d="${line}"/>`;
  }).join('');
  const dots = segments.flat().map((point) => `<circle class="trend-point" cx="${coordinate(point.x)}" cy="${coordinate(point.y)}" r="2.7"><title>${point.row.date} · ${label} ${number(point.row[key])}</title></circle>`).join('');
  const ticks = [0, maximum / 2, maximum].map((value) => `<g class="chart-axis"><line x1="${left}" y1="${coordinate(y(value))}" x2="${right}" y2="${coordinate(y(value))}"/><text x="${left - 12}" y="${coordinate(y(value) + 4)}" text-anchor="end">${chartNumber(value)}</text></g>`).join('');
  const dateTicks = [0, Math.floor((series.length - 1) / 2), series.length - 1].map((index) => `<text class="chart-date" x="${coordinate(x(index))}" y="${height - 12}" text-anchor="${index === 0 ? 'start' : index === series.length - 1 ? 'end' : 'middle'}">${series[index].date.slice(5).replace('-', '/')}</text>`).join('');
  const highlightStart = x(Math.max(0, series.length - 7));
  return `<article class="chart-card chart-${key}">
    <div class="chart-heading"><h3>${label}</h3><span>近 56 日 · ${valid.length} 日有数据</span></div>
    <svg data-chart="${key}" data-segments="${segments.length}" data-points="${valid.length}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="chart-${key}-title chart-${key}-description">
      <title id="chart-${key}-title">近 56 日${label}趋势</title>
      <desc id="chart-${key}-description">${series[0].date} 至 ${series.at(-1).date}；${valid.length} 日有数据，${series.length - valid.length} 日缺失。缺失数据不连接，浅色区域表示最近 7 天。</desc>
      <rect class="chart-window" x="${coordinate(highlightStart)}" y="${top}" width="${coordinate(right - highlightStart)}" height="${bottom - top}"/>
      ${ticks}${lines}${dots}${dateTicks}
    </svg>
  </article>`;
}

function renderTrends(seo) {
  const series = dailySeries(seo);
  if (!series.length) return '<p class="empty">尚无日数据，暂不能绘制趋势。</p>';
  return `<div class="charts">${renderChart(series, 'clicks', '搜索点击')}${renderChart(series, 'impressions', '搜索曝光')}</div>
    <p class="section-note">浅色区域为最近 7 天；断点表示缺失数据。点击与曝光使用各自的刻度。</p>
    <details class="detail-block"><summary>查看每日数据 <span class="summary-count">${series.length} 日</span></summary>
      <div class="table-scroll"><table><caption class="visually-hidden">最近 56 日搜索指标，破折号表示未提供数据。</caption><thead><tr><th scope="col">日期</th><th scope="col">点击</th><th scope="col">曝光</th><th scope="col">CTR</th><th scope="col">平均位置</th></tr></thead><tbody>
      ${series.map((row) => `<tr><th scope="row">${row.date}</th><td>${number(row.clicks)}</td><td>${number(row.impressions)}</td><td>${metricValue(row.ctr, SEO_METRICS[2])}</td><td>${metricValue(row.position, SEO_METRICS[3])}</td></tr>`).join('')}
      </tbody></table></div>
    </details>`;
}

function renderMoverTable(rows, type, index) {
  const entries = list(rows).filter(record);
  if (!entries.length) return `<p class="empty">未提供${type === 'pages' ? '页面' : '查询词'}变化明细。</p>`;
  return `<div class="table-scroll"><table class="mover-table"><caption class="visually-hidden">${type === 'pages' ? '页面' : '查询词'}点击变化</caption><thead><tr><th scope="col">${type === 'pages' ? '页面' : '查询词'}</th><th scope="col">当前点击</th><th scope="col">此前点击</th><th scope="col">点击变化</th><th scope="col">来源</th></tr></thead><tbody>
    ${entries.map((row) => {
      const delta = row.click_change;
      const tone = !finite(delta) || delta === 0 ? 'neutral' : delta > 0 ? 'positive' : 'negative';
      const key = string(row.key) || '未提供名称';
      const deltaLabel = finite(delta) ? `${delta > 0 ? '+' : ''}${number(delta)}` : '—';
      return `<tr><th scope="row" class="text-cell">${type === 'pages' ? link(key, key) : escape(key)}</th><td>${number(row.current?.clicks)}</td><td>${number(row.previous?.clicks)}</td><td class="${tone}">${deltaLabel}</td><td>${references(row.evidence_ids, index) || '—'}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function renderMovers(seo, index) {
  return `<section class="panel" aria-labelledby="movers-heading"><div class="section-heading"><div><span class="eyebrow">CHANGES</span><h2 id="movers-heading">哪些页面和查询发生了变化</h2></div></div>
    <p class="section-note">以下为选取的明细，不能直接加总为全站数据。表中零值代表已观测为零，破折号表示缺失。</p>
    ${['7d', '28d'].map((key) => `<details class="detail-block"${key === '7d' ? ' open' : ''}><summary>最近 ${key === '7d' ? '7' : '28'} 天的变化</summary><div class="detail-content"><h3 class="table-title">页面</h3>${renderMoverTable(seo.movers?.[key]?.pages, 'pages', index)}<h3 class="table-title">查询词</h3>${renderMoverTable(seo.movers?.[key]?.queries, 'queries', index)}</div></details>`).join('')}
  </section>`;
}

function renderSeo(seo, index) {
  if (!record(seo)) return `<section class="panel missing-data" aria-labelledby="seo-heading"><span class="eyebrow">SEARCH PERFORMANCE</span><h2 id="seo-heading">暂不能判断搜索增长</h2><p>本次没有可用的 Search Console 指标，无法判断搜索曝光、点击、点击率或平均位置的变化。</p><p class="section-note">页面检查可以发现技术问题，但不能替代真实搜索效果数据。详情见数据来源与已知缺口。</p></section>`;
  return `<section class="panel" aria-labelledby="seo-heading"><div class="section-heading"><div><span class="eyebrow">SEARCH PERFORMANCE</span><h2 id="seo-heading">搜索表现</h2></div><span class="section-meta">数据截至 ${escape(dateLabel(seo.data_through))}</span></div>
    ${renderRanges(seo.comparisons)}${renderMetrics(seo.comparisons)}
    <div class="subsection-heading"><h3>每天的变化</h3><span>统计时区：${escape(string(seo.data_timezone) || '未提供')}</span></div>
    ${renderTrends(seo)}
  </section>${renderMovers(seo, index)}`;
}

function renderAnalytics(analytics) {
  if (!record(analytics)) return '';
  return `<section class="panel" aria-labelledby="analytics-heading"><div class="section-heading"><div><span class="eyebrow">ON-SITE PERFORMANCE</span><h2 id="analytics-heading">站内表现</h2></div><span class="section-meta">Google Analytics 4</span></div>
    <p class="section-note">请结合数据来源中的渠道筛选和关键事件设置理解这些指标。</p>
    ${renderRanges(analytics.comparisons)}${renderMetrics(analytics.comparisons, ANALYTICS_METRICS)}
  </section>`;
}

const PAGE_FIELD_NAMES = { title: '页面标题', description: '页面描述', canonical: 'Canonical', robots: 'Robots 指令' };

function renderPageChanges(changes, index) {
  const entries = list(changes).filter(record);
  if (!entries.length) return '';
  const value = (text) => text === null || text === undefined ? '—' : text === '' ? '（空）' : escape(text);
  return `<details class="detail-block"><summary>页面内容与声明变化 <span class="summary-count">${number(entries.length)} 处</span></summary><div class="detail-content"><p class="section-note">以下为与上次成功检查的差异。变化本身不代表 SEO 改善或恶化。</p><div class="table-scroll"><table><caption class="visually-hidden">页面字段变化对比</caption><thead><tr><th scope="col">页面</th><th scope="col">字段</th><th scope="col">此前</th><th scope="col">本次</th><th scope="col">来源</th></tr></thead><tbody>
    ${entries.map((item) => `<tr><th scope="row" class="text-cell">${link(item.page_url, string(item.page_url) || '未提供页面地址')}</th><td>${escape(PAGE_FIELD_NAMES[item.field] || item.field || '未提供')}</td><td class="change-value">${value(item.before)}</td><td class="change-value">${value(item.after)}</td><td>${references(item.evidence_ids, index) || '—'}</td></tr>`).join('')}
    </tbody></table></div></div></details>`;
}

function renderChecks(checks, index) {
  const findings = list(checks?.findings).filter(record);
  const severity = { high: ['高', 'negative'], medium: ['中', 'warning'], low: ['低', 'neutral'] };
  const states = { new: '新增', ongoing: '持续', resolved: '本次未见', unverified: '待核验' };
  const counts = [
    ['已检查页面', checks?.checked_pages], ['新增问题', checks?.new_count],
    ['持续问题', checks?.ongoing_count], ['本次未见', checks?.resolved_count],
  ];
  const fallback = finite(checks?.checked_pages) && checks.checked_pages > 0
    ? `本次检查的 ${number(checks.checked_pages)} 个页面没有记录到问题。此结论仅覆盖本次检查范围。`
    : '本次未提供有效的页面检查结果。';
  return `<section class="panel" aria-labelledby="checks-heading"><div class="section-heading"><div><span class="eyebrow">SITE HEALTH</span><h2 id="checks-heading">页面检查</h2></div>${finite(checks?.attempted_pages) ? `<span class="section-meta">尝试访问 ${number(checks.attempted_pages)} 页</span>` : ''}</div>
    <div class="check-counts">${counts.map(([label, value]) => `<div><span>${label}</span><strong>${number(value)}</strong></div>`).join('')}</div>
    ${findings.length ? `<div class="findings">${findings.map((finding) => {
      const [level, tone] = severity[finding.severity] ?? severity.low;
      return `<article class="finding${finding.state === 'resolved' ? ' resolved' : ''}"><div class="finding-heading"><span class="badge ${finding.state === 'resolved' ? 'positive' : tone}">${escape(states[finding.state] || '待核验')}</span><span class="finding-type">${escape(string(finding.check_type) || '页面检查')}</span><span class="muted">优先级：${level}</span></div><p class="finding-description">${escape(finding.description)}</p>${finding.status_note ? `<p class="section-note">${escape(finding.status_note)}</p>` : ''}<div class="finding-url">${link(finding.page_url, string(finding.page_url) || '未提供页面地址')}</div><div class="finding-footer"><span>首次 ${escape(observedDateLabel(finding.first_seen))} · 最近 ${escape(observedDateLabel(finding.last_seen))}</span>${references(finding.evidence_ids, index)}</div></article>`;
    }).join('')}</div>` : `<p class="empty">${fallback}</p>`}
    ${renderPageChanges(checks?.changes, index)}
  </section>`;
}

function renderHypotheses(insights, index) {
  const hypotheses = list(insights?.hypotheses).filter(record);
  const confidence = { high: '高', medium: '中', low: '低' };
  return `<section class="panel" aria-labelledby="hypotheses-heading"><div class="section-heading"><div><span class="eyebrow">INTERPRETATION</span><h2 id="hypotheses-heading">可能的原因</h2></div><span class="section-meta">以下为原因假设</span></div>
    ${hypotheses.length ? `<div class="hypotheses">${hypotheses.map((item) => `<article class="hypothesis"><div class="hypothesis-header"><h3>${escape(item.title)}</h3><span class="badge neutral">置信度 ${escape(confidence[item.confidence] || '未评估')}</span></div><p>${escape(item.explanation)}</p>${references(item.evidence_ids, index)}<div class="verification"><strong>如何验证</strong><p>${escape(string(item.verification) || '尚未提供验证方法。')}</p></div></article>`).join('')}</div>` : '<p class="empty">本次没有足够证据提出具体原因假设。</p>'}
  </section>`;
}

function renderActions(insights, index) {
  const actions = list(insights?.actions).filter(record).slice().sort((first, second) => (finite(first.priority) ? first.priority : 999) - (finite(second.priority) ? second.priority : 999));
  const efforts = { small: '较小', medium: '中等', large: '较大' };
  return `<section class="panel actions-panel" aria-labelledby="actions-heading"><div class="section-heading"><div><span class="eyebrow">NEXT ACTIONS</span><h2 id="actions-heading">优先做什么</h2></div><span class="section-meta">建议，尚未执行</span></div>
    ${actions.length ? `<ol class="actions">${actions.map((action, position) => `<li class="action"><span class="action-number">${String(position + 1).padStart(2, '0')}</span><div class="action-body"><div class="action-header"><h3>${escape(action.title)}</h3><span class="badge neutral">工作量 ${escape(efforts[action.effort] || '待估算')}</span></div><p>${escape(action.reason)}</p>${list(action.target_urls).length ? `<div class="target-urls">${list(action.target_urls).map((url) => link(url, url)).join('')}</div>` : ''}<div class="acceptance"><strong>验收标准</strong><p>${escape(string(action.acceptance) || '尚未提供验收标准。')}</p></div>${references(action.evidence_ids, index)}</div></li>`).join('')}</ol>` : '<p class="empty">本次未产生需要优先处理的新动作。</p>'}
  </section>`;
}

function renderSources(report) {
  const sources = list(report.sources).filter(record);
  const limitations = list(report.insights?.limitations).filter((value) => typeof value === 'string' && value.trim());
  limitations.push(...list(report.seo?.notes).filter((value) => typeof value === 'string' && value.trim()));
  if (!record(report.seo)) limitations.unshift('缺少 Search Console 指标，暂不能判断搜索增长。');
  sources.forEach((source) => {
    if (source.status !== 'ok') {
      const name = SOURCE_NAMES[source.id] || string(source.id) || '未命名来源';
      limitations.push(`${name}：${string(source.reason) || SOURCE_STATES[source.status]?.[0] || '状态未知'}。`);
    }
  });
  const unique = [...new Set(limitations)];
  return `<section class="panel" aria-labelledby="sources-heading"><div class="section-heading"><div><span class="eyebrow">DATA & LIMITATIONS</span><h2 id="sources-heading">数据来源与已知缺口</h2></div></div>
    ${unique.length ? `<ul class="limitations">${unique.map((limitation) => `<li>${escape(limitation)}</li>`).join('')}</ul>` : '<p class="section-note">本次未记录额外的数据缺口。以下列出实际使用的数据源。</p>'}
    <div class="source-list">${sources.map((source) => {
      const [label, tone] = SOURCE_STATES[source.status] || ['状态未知', 'neutral'];
      return `<article class="source"><div class="source-heading"><h3>${escape(SOURCE_NAMES[source.id] || source.id || '未命名来源')}</h3><span class="badge ${tone}">${label}</span></div><dl><div><dt>数据截至</dt><dd>${escape(dateLabel(source.data_through))}</dd></div><div><dt>统计时区</dt><dd>${escape(string(source.data_timezone) || '未提供')}</dd></div><div><dt>采集时间</dt><dd>${escape(timestampLabel(source.collected_at, report.site?.timezone))}</dd></div></dl>${source.reason ? `<p class="source-reason">${escape(source.reason)}</p>` : ''}</article>`;
    }).join('') || '<p class="empty">未提供数据源状态。</p>'}</div>
    ${record(report.seo?.coverage) && Object.keys(report.seo.coverage).length ? `<details class="detail-block"><summary>采集范围与覆盖情况</summary><pre>${json(report.seo.coverage)}</pre></details>` : ''}
  </section>`;
}

function renderEvidence(evidence) {
  return `<section class="panel" aria-labelledby="evidence-heading"><div class="section-heading"><div><span class="eyebrow">EVIDENCE</span><h2 id="evidence-heading">证据与原始依据</h2></div><span class="section-meta">${evidence.filter(record).length} 条</span></div>
    ${evidence.map((item, position) => record(item) ? `<details class="evidence-item" id="evidence-${position + 1}"><summary><span class="evidence-number">${String(position + 1).padStart(2, '0')}</span><span>${escape(string(item.title) || item.id || '未命名证据')}</span></summary><div class="evidence-content"><div class="evidence-meta"><span>${escape(SOURCE_NAMES[item.source_id] || item.source_id || '来源未提供')}</span><span>采集于 ${escape(timestampLabel(item.observed_at, 'UTC'))}</span>${optionalLink(item.url, '打开来源 ↗')}</div>${record(item.details) || Array.isArray(item.details) ? `<pre>${json(item.details)}</pre>` : item.details ? `<p>${escape(item.details)}</p>` : '<p class="section-note">本条证据未附带额外明细。</p>'}</div></details>` : '').join('') || '<p class="empty">本次未提供可引用证据。</p>'}
  </section>`;
}

function renderRun(report) {
  const run = report.run || {};
  return `<details class="run-details"><summary>生成记录</summary><dl><div><dt>运行编号</dt><dd>${escape(run.id ?? '未提供')} · 第 ${number(run.attempt)} 次</dd></div><div><dt>分析模型</dt><dd>${escape(string(run.model) || '未提供')}</dd></div><div><dt>代码版本</dt><dd class="code-sha">${escape(string(run.code_sha) || '未提供')}</dd></div><div><dt>报告状态</dt><dd>${report.report_status === 'complete' ? 'complete' : 'limited'}</dd></div></dl>${optionalLink(run.url, '查看本次运行 ↗')}</details>`;
}

const CSS = `
:root{color-scheme:light;--ink:#18283e;--muted:#66778a;--line:#e2e9ed;--green:#08765c;--red:#b3423f;--amber:#9b6713;--paper:#fff;--bg:#f2f5f7;--accent:#147a70;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.65}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact}a{color:#176f82;text-underline-offset:3px;text-decoration-thickness:1px;overflow-wrap:anywhere}a:hover{color:#0c4b5c}a:focus-visible,summary:focus-visible{outline:3px solid #55ab9b;outline-offset:4px;border-radius:4px}h1,h2,h3,p{margin:0}h1,h2,h3{line-height:1.3}h2{font-size:23px;letter-spacing:-.5px}h3{font-size:16px}p{overflow-wrap:anywhere}strong{font-weight:650}button,input{font:inherit}
.change-value{min-width:180px;max-width:340px;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left}
.shell{width:min(1140px,100% - 48px);margin:0 auto}.topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:26px 0;color:var(--muted)}.brand{display:flex;gap:11px;align-items:center;font-weight:650;color:var(--ink);font-size:14px;letter-spacing:.02em}.brand-mark{width:29px;height:29px;color:var(--accent);flex:none}.top-links{display:flex;gap:22px;font-size:13px}.top-links a{text-decoration:none}.hero{padding:35px 39px 32px;background:linear-gradient(130deg,#fff 55%,#eaf5f2);border:1px solid #dce7e5;border-radius:20px;margin-bottom:24px;position:relative;overflow:hidden}.hero-top{display:flex;justify-content:space-between;align-items:flex-start;gap:25px}.eyebrow{display:block;font-size:10px;font-weight:750;letter-spacing:.16em;color:var(--accent);margin-bottom:10px}.hero h1{font-size:37px;letter-spacing:-1px;margin-bottom:11px;overflow-wrap:anywhere}.hero-date{font-size:14px;color:var(--muted);font-variant-numeric:tabular-nums}.hero-status{display:flex;flex-direction:column;align-items:flex-end;gap:10px;flex:none}.badge{display:inline-flex;align-items:center;gap:5px;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:650;white-space:nowrap;background:#eef2f5;color:var(--muted)}.badge.positive{background:#e7f4ee}.badge.negative{background:#faeceb}.badge.warning{background:#fff3dc}.badge.neutral{background:#edf1f4}.positive{color:var(--green)}.negative{color:var(--red)}.warning{color:var(--amber)}.neutral,.muted{color:var(--muted)}.hero-summary{margin-top:28px;padding-top:25px;border-top:1px solid #dce8e3}.hero-summary h2{font-size:13px;color:var(--accent);margin-bottom:10px;letter-spacing:.02em}.hero-summary p{font-size:19px;line-height:1.8;max-width:910px;white-space:pre-line}.hero-freshness{display:flex;gap:10px 21px;flex-wrap:wrap;margin-top:22px;font-size:12px;color:var(--muted)}.hero-freshness strong{color:var(--ink)}
main{display:grid;gap:22px}.panel{background:var(--paper);border:1px solid var(--line);border-radius:16px;padding:29px 31px;min-width:0;box-shadow:0 2px 3px #142a3c02}.section-heading{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;margin-bottom:20px}.section-heading .eyebrow{margin-bottom:7px}.section-meta{color:var(--muted);font-size:12px;text-align:right}.section-note{font-size:12px;color:var(--muted);line-height:1.8;margin:12px 0}.periods{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:19px}.period{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:12px;background:#f7f9fa;border:1px solid #edf1f3;border-radius:8px;padding:10px 13px}.period strong{color:var(--ink)}.period span{font-variant-numeric:tabular-nums}.period small{display:block;flex-basis:100%;font-size:11px;color:var(--muted)}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric-grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}.metric-card{border:1px solid var(--line);border-radius:12px;padding:19px 18px 15px;min-width:0}.metric-card h3{font-size:14px;margin-bottom:16px}.metric-period-label{font-size:11px;color:var(--muted);margin-bottom:4px}.metric-value{font-size:32px;font-weight:650;letter-spacing:-1.1px;font-variant-numeric:tabular-nums;line-height:1.3;overflow-wrap:anywhere}.metric-change{font-size:12px;font-weight:650;min-height:21px;margin-top:4px}.metric-baseline{font-size:11px;color:var(--muted);margin-top:2px;overflow-wrap:anywhere}.metric-period.secondary{border-top:1px solid #e9eff1;margin-top:14px;padding-top:13px}.secondary .metric-value{font-size:23px;letter-spacing:-.5px}.secondary .metric-change{font-size:11px}.metric-note{font-size:10px;color:var(--muted);line-height:1.7;margin-top:14px}.subsection-heading{display:flex;justify-content:space-between;gap:20px;align-items:center;margin:30px 0 14px}.subsection-heading span{font-size:11px;color:var(--muted)}.charts{display:grid;gap:14px}.chart-card{padding:16px 15px 6px;border:1px solid var(--line);border-radius:11px;--chart-color:#148675;--chart-fill:#d4ede5}.chart-impressions{--chart-color:#4375b2;--chart-fill:#e0eaf7}.chart-heading{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:0 5px}.chart-heading h3{font-size:13px}.chart-heading span{font-size:11px;color:var(--muted)}.chart-card svg{display:block;width:100%;height:auto;overflow:visible}.chart-window{fill:#f0f5f4}.chart-axis line{stroke:#e1e8eb;stroke-dasharray:4 5;stroke-width:1}.chart-axis text,.chart-date{font-family:inherit;font-size:12px;fill:#748397}.trend-area{fill:var(--chart-fill);opacity:.65}.trend-line{stroke:var(--chart-color);stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;fill:none}.trend-point{fill:var(--chart-color);stroke:#fff;stroke-width:1}.chart-empty{min-height:100px;display:flex;align-items:center}
.detail-block{border:1px solid var(--line);border-radius:9px;margin-top:13px;overflow:hidden}.detail-block>summary{padding:12px 15px;font-size:13px;font-weight:600;background:#fafbfc}.summary-count{font-weight:400;color:var(--muted);font-size:11px;margin-left:8px}summary{cursor:pointer;overflow-wrap:anywhere}summary::marker{color:#8ca2ab}.detail-content{padding:0 15px 15px}.table-scroll{width:100%;overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}th,td{padding:10px 13px;text-align:right;border-bottom:1px solid #ecf0f3;vertical-align:top}thead th{background:#f8fafb;color:var(--muted);font-size:11px;font-weight:600;white-space:nowrap}tbody th{font-weight:450}th:first-child,td:first-child{text-align:left}tbody tr:last-child>*{border-bottom:0}tbody tr:hover{background:#f8fbfa}.text-cell{max-width:380px;min-width:220px;overflow-wrap:anywhere}.mover-table td:nth-child(2),.mover-table td:nth-child(3),.mover-table td:nth-child(4){white-space:nowrap}.mover-table td:last-child{min-width:90px}.table-title{font-size:13px;margin:20px 0 8px}.empty{padding:19px 0;color:var(--muted);font-size:13px}.missing-data{background:#fffcf5;border-color:#eadfc8}.missing-data h2{margin-bottom:15px}.missing-data>p{font-size:14px;max-width:830px}.check-counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:#f7f9fa;border-radius:10px;margin-bottom:19px}.check-counts>div{padding:15px 20px}.check-counts>div+div{border-left:1px solid var(--line)}.check-counts span{display:block;color:var(--muted);font-size:11px}.check-counts strong{display:block;font-size:25px;margin-top:3px;line-height:1.4;font-variant-numeric:tabular-nums}.findings{display:grid;gap:12px}.finding{border:1px solid var(--line);border-left:3px solid #aebfca;padding:16px 19px;border-radius:8px}.finding.resolved{border-left-color:#66ab8e;background:#fcfefc}.finding-heading{display:flex;align-items:center;flex-wrap:wrap;gap:11px;font-size:11px}.finding-type{font-weight:650}.finding-description{font-size:14px;line-height:1.85;margin:9px 0 6px}.finding-url{font-size:11px;overflow-wrap:anywhere}.finding-footer{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;color:var(--muted);font-size:10px;margin-top:11px}.references{display:inline-flex;gap:5px;flex-wrap:wrap}.reference{font-size:10px;background:#edf5f3;border-radius:4px;padding:2px 7px;text-decoration:none;white-space:nowrap;color:#286f65}.hypotheses{display:grid;gap:13px}.hypothesis{border:1px solid var(--line);border-radius:10px;padding:20px}.hypothesis-header,.action-header{display:flex;justify-content:space-between;gap:15px;align-items:flex-start}.hypothesis-header h3,.action-header h3{font-size:16px;overflow-wrap:anywhere}.hypothesis>p,.action-body>p{font-size:14px;color:#475b70;line-height:1.85;white-space:pre-line;margin:10px 0 13px}.verification,.acceptance{background:#f6f8fa;border-radius:7px;padding:11px 14px;margin-top:13px;font-size:12px}.verification strong,.acceptance strong{font-size:11px;color:var(--muted)}.verification p,.acceptance p{margin-top:4px;white-space:pre-line}.actions-panel{border-top:3px solid #70a79a}.actions{list-style:none;padding:0;margin:0}.action{display:flex;gap:18px;padding:22px 0}.action+.action{border-top:1px solid var(--line)}.action:first-child{padding-top:2px}.action:last-child{padding-bottom:0}.action-number{flex:none;font-size:26px;line-height:1.2;color:#7aa89c;font-weight:350;width:34px}.action-body{min-width:0;flex:1}.action-body>.references{margin-top:12px}.target-urls{display:flex;flex-direction:column;gap:6px;font-size:11px;overflow-wrap:anywhere}.limitations{font-size:13px;line-height:1.85;margin:0 0 21px;padding:15px 20px 15px 35px;background:#fffbef;border:1px solid #eee4c9;border-radius:9px}.limitations li+li{margin-top:6px}.source-list{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}.source{padding:17px;border:1px solid var(--line);border-radius:9px;min-width:0}.source-heading{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.source-heading h3{font-size:13px;overflow-wrap:anywhere}dl{margin:13px 0 0;display:grid;gap:7px;font-size:11px}dl>div{display:grid;grid-template-columns:70px minmax(0,1fr);gap:8px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}.source-reason{font-size:11px;color:var(--muted);margin-top:13px}.evidence-item{border:1px solid var(--line);border-radius:8px;scroll-margin-top:20px;margin-top:9px;overflow:hidden}.evidence-item>summary{padding:14px;font-size:13px;font-weight:550;background:#fafbfc}.evidence-number{font-size:11px;font-weight:500;color:var(--muted);margin-right:8px}.evidence-content{padding:15px 17px}.evidence-meta{display:flex;gap:9px 20px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-bottom:12px}.evidence-item:target{outline:2px solid #6bab9b;outline-offset:3px}.evidence-item:target>.evidence-content{display:block}pre{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:11px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#f5f7f9;border-radius:7px;margin:10px 0 0;max-height:520px;overflow:auto}.detail-block>pre{margin:12px}.run-details{font-size:12px;background:#eaf0f3;padding:14px 18px;border-radius:9px;color:var(--muted)}.run-details dl{margin-bottom:12px}.run-details dl>div{grid-template-columns:82px minmax(0,1fr)}.code-sha{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.footer{padding:25px 0 36px;color:var(--muted);font-size:11px}.footer-top{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:20px}.footer-links{display:flex;gap:20px;flex-wrap:wrap}.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:800px){.shell{width:min(100% - 28px,1140px)}.hero{padding:27px}.hero h1{font-size:30px}.hero-summary p{font-size:17px}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.panel{padding:24px}.periods{grid-template-columns:1fr}.metric-value{font-size:29px}.section-heading{align-items:flex-start}.section-meta{max-width:45%}.metric-grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}.metric-grid.three .metric-card{padding:15px 12px}.metric-grid.three .metric-value{font-size:25px}.hypothesis-header,.action-header{flex-wrap:wrap}.chart-axis text,.chart-date{font-size:14px}}
@media(max-width:500px){.shell{width:calc(100% - 20px)}.topbar{padding:20px 5px;align-items:flex-start}.top-links{gap:12px;font-size:11px}.brand{font-size:12px}.brand-mark{width:23px;height:23px}.hero{padding:23px 19px;border-radius:13px}.hero-top{flex-direction:column;gap:15px}.hero-status{align-items:flex-start;flex-direction:row}.hero h1{font-size:28px}.hero-summary{margin-top:20px;padding-top:19px}.hero-summary p{font-size:16px}.hero-freshness{font-size:11px;gap:5px 15px}.panel{padding:22px 16px;border-radius:12px}.section-heading{gap:10px;flex-wrap:wrap}h2{font-size:20px}.section-meta{max-width:100%;text-align:left}.metric-card{padding:15px 12px}.metric-value{font-size:26px}.metric-change{font-size:11px}.secondary .metric-value{font-size:21px}.metric-note{font-size:10px}.metric-grid.three{grid-template-columns:1fr}.metric-grid.three .metric-card{display:grid;grid-template-columns:1fr 1fr;gap:10px 18px}.metric-grid.three h3{grid-column:1 / -1;margin:0}.metric-grid.three .secondary{border-top:0;border-left:1px solid var(--line);padding-top:0;padding-left:18px;margin-top:0}.check-counts>div{padding:11px 10px}.check-counts strong{font-size:23px}.check-counts span{font-size:10px}.finding{padding:14px}.subsection-heading{align-items:flex-start;gap:10px}.subsection-heading span{font-size:10px;text-align:right}.chart-card{padding:13px 7px 6px}.chart-heading span{font-size:10px}.source-list{grid-template-columns:1fr}.hypothesis{padding:17px}.action{gap:11px}.action-number{font-size:23px;width:29px}.action-header h3{font-size:15px}.footer-top{align-items:flex-start;flex-direction:column;gap:12px}.footer{padding-left:5px;padding-right:5px}}
@media(prefers-reduced-motion:no-preference){a{transition:color .15s ease}html{scroll-behavior:smooth}}
@media print{@page{size:A4;margin:13mm}body{background:#fff;font-size:11px}.shell{width:100%}.topbar{padding:0 0 14px}.top-links,.footer-links{display:none}.hero{padding:22px;margin-bottom:15px}.hero h1{font-size:28px}.hero-summary p{font-size:15px}.panel{padding:20px;border-radius:8px;box-shadow:none}main{gap:14px}.metric-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.metric-card{padding:12px}.metric-value{font-size:25px}.secondary .metric-value{font-size:20px}.panel,.hero,.metric-card,.action,.finding,.hypothesis,.source,.chart-card{break-inside:avoid}.evidence-item,.detail-block{break-inside:auto}.table-scroll{overflow:visible}table{font-size:10px}thead{display:table-header-group}tr{break-inside:avoid}details>*{display:block!important}details::details-content{display:block!important;content-visibility:visible!important}pre{max-height:none;overflow:visible;font-size:9px}.reference{background:#edf5f3}.footer{padding-bottom:0}.periods{grid-template-columns:1fr 1fr}.chart-axis text,.chart-date{font-size:12px}a{text-decoration:none}}
`;

/** Render the versioned report contract into a standalone, script-free HTML document. */
export function renderReport(report) {
  if (!record(report) || report.schema_version !== 1) {
    throw new TypeError('renderReport requires a report with schema_version: 1');
  }
  const site = record(report.site) ? report.site : {};
  const name = string(site.name) || 'NocoBase';
  const title = `${name} 增长日报`;
  const evidence = list(report.evidence);
  const index = evidenceIndex(evidence);
  const limited = report.report_status !== 'complete' || !record(report.seo);
  const summary = string(report.insights?.summary) || (record(report.seo)
    ? '最近 7 天与 28 天的搜索表现已整理。请结合页面变化、原因假设与优先动作判断本次需要关注的事项。'
    : '本次没有可用的搜索效果数据，暂不能判断搜索增长。下方展示已获取的页面检查和数据来源状态。');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="robots" content="noindex,nofollow">
  <title>${escape(title)} · ${escape(dateLabel(report.report_date))}</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="shell">
    <nav class="topbar" aria-label="报告导航"><div class="brand"><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="17" width="7" height="13" rx="2" fill="currentColor" opacity=".4"/><rect x="12" y="10" width="7" height="20" rx="2" fill="currentColor" opacity=".7"/><rect x="22" y="2" width="7" height="28" rx="2" fill="currentColor"/></svg><span>${escape(name)} / 增长观察</span></div><div class="top-links">${optionalLink(site.url, '访问网站 ↗')}${optionalLink(report.history?.index_url, '历史报告 ↗')}</div></nav>
    <header class="hero"><div class="hero-top"><div><span class="eyebrow">GROWTH DAILY</span><h1>${escape(title)}</h1><p class="hero-date">${escape(dateLabel(report.report_date))} · 搜索、站点与下一步行动</p></div><div class="hero-status"><span class="badge ${limited ? 'warning' : 'positive'}">${limited ? '数据受限' : '已完成'}</span></div></div><div class="hero-summary"><h2>本次观察</h2><p>${escape(summary)}</p></div><div class="hero-freshness"><span>生成于 <strong>${escape(timestampLabel(report.generated_at, site.timezone))}</strong></span><span>搜索数据截至 <strong>${escape(dateLabel(report.seo?.data_through))}</strong></span><span>分析模型 <strong>${escape(string(report.run?.model) || '未提供')}</strong></span></div></header>
    <main>
      ${renderSeo(report.seo, index)}
      ${renderAnalytics(report.analytics)}
      ${renderChecks(report.site_checks, index)}
      ${renderHypotheses(report.insights, index)}
      ${renderActions(report.insights, index)}
      ${renderSources(report)}
      ${renderEvidence(evidence)}
    </main>
    <footer class="footer"><div class="footer-top"><p>指标和页面发现以所列证据为依据；原因假设与建议由模型解读生成。</p><div class="footer-links">${optionalLink(report.history?.previous_report_url, '← 上次报告')}${optionalLink(report.history?.index_url, '全部历史报告 ↗')}</div></div>${renderRun(report)}</footer>
  </div>
</body>
</html>`;
}

// Treat every model or collected string as literal Markdown text. The only
// formatting and link destinations in this summary are emitted by this module.
function markdown(value, oneLine = false) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  return (oneLine ? text.replace(/\s+/g, ' ') : text)
    .replace(/[&<>]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])
    .replace(/[\\`*_{}\[\]()#+.!|~\-]/g, '\\$&');
}

function markdownLink(url, label) {
  const href = safeUrl(url);
  if (!href) return markdown(label, true);
  // Parentheses and pipes have special meaning in Markdown destinations/tables.
  const destination = href.replace(/[()|\\]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `[${markdown(label, true)}](${destination})`;
}

function markdownReferences(ids, evidence, index) {
  const positions = [...new Set(list(ids).map((id) => index.get(id)).filter(Boolean))];
  return positions.length ? `依据：${positions.map((position) => markdownLink(evidence[position - 1]?.url, `证据 ${position}`)).join('、')}` : '';
}

function markdownComparisons(comparisons, definitions) {
  const rows = definitions.map((definition) => {
    const cells = [definition.label];
    for (const key of ['7d', '28d']) {
      const metric = comparisons?.[key]?.metrics?.[definition.key];
      cells.push(metricValue(metric?.current, definition), metricValue(metric?.previous, definition), change(metric, definition).text);
    }
    return `| ${cells.map((cell) => markdown(cell, true)).join(' | ')} |`;
  });
  return [
    ...['7d', '28d'].map((key) => `- 最近 ${key === '7d' ? '7' : '28'} 天：${markdown(periodLabel(comparisons?.[key]?.current_period))}；对比 ${markdown(periodLabel(comparisons?.[key]?.previous_period))}`),
    '',
    '| 指标 | 最近 7 天 | 前 7 天 | 变化 | 最近 28 天 | 前 28 天 | 变化 |',
    '| :--- | ---: | ---: | :--- | ---: | ---: | :--- |',
    ...rows,
  ].join('\n');
}

/** Render a compact GitHub-readable companion without accepting raw Markdown/HTML. */
export function renderMarkdown(report) {
  if (!record(report) || report.schema_version !== 1) {
    throw new TypeError('renderMarkdown requires a report with schema_version: 1');
  }
  const name = string(report.site?.name) || 'NocoBase';
  const evidence = list(report.evidence);
  const index = evidenceIndex(evidence);
  const insights = record(report.insights) ? report.insights : {};
  const limited = report.report_status !== 'complete' || !record(report.seo);
  const lines = [
    `# ${markdown(name, true)} 增长日报 · ${markdown(dateLabel(report.report_date))}`,
    '',
    `- 报告状态：${limited ? '数据受限' : '已完成'}`,
    `- 生成时间：${markdown(timestampLabel(report.generated_at, report.site?.timezone))}`,
    `- 搜索数据截至：${markdown(dateLabel(report.seo?.data_through))}；统计时区：${markdown(string(report.seo?.data_timezone) || '未提供', true)}`,
    `- 分析模型：${markdown(string(report.run?.model) || '未提供', true)}`,
    '- 完整内容：[下载 HTML 报告](report.html) · [结构化数据](report.json)',
    '',
    '## 本次观察',
    '',
    markdown(string(insights.summary) || (record(report.seo)
      ? '最近 7 天与 28 天的搜索表现已整理，请结合数据与证据判断优先事项。'
      : '本次没有可用的搜索效果数据，暂不能判断搜索增长。')),
    '',
    '## 搜索效果',
    '',
  ];
  if (record(report.seo)) {
    lines.push(markdownComparisons(report.seo.comparisons, SEO_METRICS), '',
      '点击率变化使用百分点；平均位置数值越小越靠前，也会受查询组合影响。缺失数据以“—”显示。');
    const pages = list(report.seo.movers?.['7d']?.pages).filter(record).slice(0, 5);
    if (pages.length) {
      lines.push('', '### 最近 7 天的重点页面变化', '');
      for (const page of pages) {
        const delta = finite(page.click_change) ? `${page.click_change > 0 ? '+' : ''}${number(page.click_change)}` : '缺少对比数据';
        const refs = markdownReferences(page.evidence_ids, evidence, index);
        lines.push(`- ${markdownLink(page.key, page.key)}：点击 ${number(page.current?.clicks)}，前期 ${number(page.previous?.clicks)}，变化 ${markdown(delta)}。${refs ? ` ${refs}` : ''}`);
      }
      lines.push('', '完整页面、查询变化与每日趋势见 HTML 报告。');
    }
  } else {
    lines.push('**暂不能判断搜索增长。** 页面检查可以发现技术问题，但不能替代真实搜索效果数据。');
  }
  if (record(report.analytics)) {
    lines.push('', '## 站内表现', '',
      `数据截至：${markdown(dateLabel(report.analytics.data_through))}；统计时区：${markdown(string(report.analytics.data_timezone) || '未提供', true)}。`,
      '', markdownComparisons(report.analytics.comparisons, ANALYTICS_METRICS));
  }
  const checks = record(report.site_checks) ? report.site_checks : {};
  lines.push('', '## 重点页面检查', '',
    `已检查 ${number(checks.checked_pages)} 页${finite(checks.attempted_pages) ? ` / 尝试 ${number(checks.attempted_pages)} 页` : ''}；新增 ${number(checks.new_count)}，持续 ${number(checks.ongoing_count)}，本次未见 ${number(checks.resolved_count)}。`);
  const findings = list(checks.findings).filter(record);
  const states = { new: '新增', ongoing: '持续', resolved: '本次未见', unverified: '待核验' };
  const severities = { high: '高', medium: '中', low: '低' };
  if (findings.length) {
    for (const item of findings) {
      const refs = markdownReferences(item.evidence_ids, evidence, index);
      lines.push(`- ${states[item.state] || '状态未知'} / ${severities[item.severity] || '未评估'}：${markdown(item.description, true)}${item.status_note ? ` ${markdown(item.status_note, true)}` : ''} ${markdownLink(item.page_url, item.page_url)}${refs ? `；${refs}` : ''}`);
    }
  } else lines.push('', finite(checks.checked_pages) && checks.checked_pages > 0 ? '本次未记录需要关注的页面发现。' : '本次没有可确认的页面检查结果。');
  const pageChanges = list(checks.changes).filter(record);
  if (pageChanges.length) {
    lines.push('', `另记录 ${number(pageChanges.length)} 处页面内容与声明变化；变化本身不代表 SEO 改善或恶化，完整前后对比见 HTML 报告。`, '');
    for (const item of pageChanges) lines.push(`- ${markdown(PAGE_FIELD_NAMES[item.field] || item.field || '未提供字段', true)}：${markdownLink(item.page_url, item.page_url)}`);
  }
  lines.push('', '## 可能的原因', '', '以下为待验证的假设。', '');
  const confidence = { high: '高', medium: '中', low: '低' };
  const hypotheses = list(insights.hypotheses).filter(record);
  if (!hypotheses.length) lines.push('本次没有足够证据提出具体原因假设。');
  for (const item of hypotheses) {
    lines.push(`### ${markdown(item.title, true)}（置信度：${confidence[item.confidence] || '未评估'}）`, '',
      markdown(item.explanation), '',
      `验证方法：${markdown(string(item.verification) || '尚未提供验证方法。')}`);
    const refs = markdownReferences(item.evidence_ids, evidence, index);
    if (refs) lines.push('', refs);
    lines.push('');
  }
  lines.push('## 优先动作', '', '以下建议尚未执行。', '');
  const actions = list(insights.actions).filter(record).slice().sort((first, second) => (finite(first.priority) ? first.priority : 999) - (finite(second.priority) ? second.priority : 999));
  const efforts = { small: '较小', medium: '中等', large: '较大' };
  if (!actions.length) lines.push('本次未产生需要优先处理的新动作。');
  actions.forEach((item, position) => {
    lines.push(`### ${position + 1}. ${markdown(item.title, true)}`, '',
      markdown(item.reason), '',
      `- 工作量：${efforts[item.effort] || '待估算'}`,
      `- 验收标准：${markdown(string(item.acceptance) || '尚未提供验收标准。', true)}`);
    for (const url of list(item.target_urls)) lines.push(`- 目标页面：${markdownLink(url, url)}`);
    const refs = markdownReferences(item.evidence_ids, evidence, index);
    if (refs) lines.push(`- ${refs}`);
    lines.push('');
  });
  lines.push('## 数据来源与已知缺口', '');
  const limitations = [...list(insights.limitations), ...list(report.seo?.notes)].filter((value) => typeof value === 'string' && value.trim());
  if (!record(report.seo)) limitations.unshift('缺少 Search Console 指标，暂不能判断搜索增长。');
  for (const limitation of [...new Set(limitations)]) lines.push(`- ${markdown(limitation, true)}`);
  for (const source of list(report.sources).filter(record)) {
    const label = SOURCE_NAMES[source.id] || string(source.id) || '未命名来源';
    lines.push(`- ${markdown(label, true)}：${SOURCE_STATES[source.status]?.[0] || '状态未知'}；数据截至 ${markdown(dateLabel(source.data_through))}${source.reason ? `；${markdown(source.reason, true)}` : ''}。`);
  }
  if (evidence.filter(record).length) {
    lines.push('', '## 证据', '');
    evidence.forEach((item, position) => {
      if (record(item)) lines.push(`- ${markdownLink(item.url, `证据 ${position + 1} · ${string(item.title) || item.id || '未命名证据'}`)}；${markdown(SOURCE_NAMES[item.source_id] || item.source_id || '来源未提供', true)}；采集于 ${markdown(timestampLabel(item.observed_at, 'UTC'))}。`);
    });
  }
  const historyLinks = [
    safeUrl(report.history?.previous_report_url) ? markdownLink(report.history.previous_report_url, '上次报告') : '',
    safeUrl(report.history?.index_url) ? markdownLink(report.history.index_url, '全部历史报告') : '',
    safeUrl(report.run?.url) ? markdownLink(report.run.url, '本次运行') : '',
  ].filter(Boolean);
  lines.push('', '---', '', '指标和页面发现以所列证据为依据；原因假设与建议由模型解读生成。');
  if (historyLinks.length) lines.push('', historyLinks.join(' · '));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
