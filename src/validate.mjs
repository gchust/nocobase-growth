import { SafeError, safeUrl } from './config.mjs';

// Small validator for the closed JSON Schema subset used by this project.
// The CLI receives the same schema; provider validation is never the only gate.
export function validateShape(value, schema) {
  const fail = () => { throw new SafeError('ANALYSIS_SCHEMA_INVALID'); };
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail();
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) { if (schema.additionalProperties === false) fail(); }
      else validateShape(item, schema.properties[key]);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) fail();
    for (const item of value) validateShape(item, schema.items);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity)) fail();
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail();
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail();
  } else { throw new SafeError('UNSUPPORTED_SCHEMA'); }
  if (schema.enum && !schema.enum.includes(value)) fail();
  return value;
}

export function validateAnalysis(value, schema, facts, config) {
  validateShape(value, schema);
  const evidence = new Set(facts.evidence.map(e => e.id));
  for (const entry of [...value.hypotheses, ...value.actions]) {
    if (entry.evidence_ids.some(id => !evidence.has(id))) throw new SafeError('ANALYSIS_UNKNOWN_EVIDENCE');
  }
  for (const action of value.actions) {
    if (action.target_urls.some(url => !safeUrl(url, config.allowed_hosts))) throw new SafeError('ANALYSIS_UNAPPROVED_URL');
  }
  if (new Set(value.actions.map(a => a.priority)).size !== value.actions.length) throw new SafeError('ANALYSIS_DUPLICATE_PRIORITY');
  return value;
}

export function validateFacts(facts) {
  if (!facts || facts.schema_version !== 1 || !Array.isArray(facts.sources)
      || facts.sources.some(source => !source || typeof source !== 'object' || Array.isArray(source))
      || !Array.isArray(facts.evidence)
      || !facts.site_checks || !Array.isArray(facts.site_checks.findings)) throw new SafeError('REPORT_FACTS_INVALID');
  const gscSources = facts.sources.filter(source => source.id === 'gsc');
  if (gscSources.length !== 1) throw new SafeError('REPORT_GSC_UNAVAILABLE');
  const gsc = gscSources[0];
  const ids = facts.evidence.map(e => e?.id);
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new SafeError('REPORT_EVIDENCE_INVALID');
  if (facts.seo === null) {
    const unconfigured = source => source?.status === 'not_configured'
      && typeof source.reason === 'string' && source.reason.trim().length > 0
      && source.data_through === null;
    if (!unconfigured(gsc)) throw new SafeError('REPORT_GSC_UNAVAILABLE');
    const ga4Sources = facts.sources.filter(source => source.id === 'ga4');
    if (facts.report_status !== 'limited' || facts.analytics !== null
        || ga4Sources.length !== 1 || !unconfigured(ga4Sources[0])) throw new SafeError('REPORT_FACTS_INVALID');
    if (facts.evidence.some(item => item.source_id === 'gsc' || item.source_id === 'ga4')) throw new SafeError('REPORT_EVIDENCE_INVALID');
    const pageSources = facts.sources.filter(source => source.id === 'pages');
    const pages = facts.site_checks.pages;
    if (pageSources.length !== 1 || !['ok', 'partial'].includes(pageSources[0].status)
        || !Array.isArray(pages) || !pages.length
        || pages.some(page => !page || typeof page.url !== 'string'
          || !['ok', 'error'].includes(page.check_status)
          || !facts.evidence.some(item => item.source_id === 'pages' && item.url === page.url))) {
      throw new SafeError('REPORT_PAGE_EVIDENCE_INVALID');
    }
    return facts;
  }
  if (gsc.status !== 'ok' && gsc.status !== 'partial') throw new SafeError('REPORT_GSC_UNAVAILABLE');
  if (!facts.seo || !Array.isArray(facts.seo.daily)) throw new SafeError('REPORT_FACTS_INVALID');
  for (const window of ['7d', '28d']) {
    const metrics = facts.seo.comparisons?.[window]?.metrics;
    if (!metrics) throw new SafeError('REPORT_METRICS_INVALID');
    for (const key of ['clicks', 'impressions', 'ctr', 'position']) {
      const metric = metrics[key];
      if (!metric || [metric.current, metric.previous, metric.absolute_change, metric.relative_change]
        .some(v => v !== null && (typeof v !== 'number' || !Number.isFinite(v)))) throw new SafeError('REPORT_METRICS_INVALID');
    }
  }
  return facts;
}
