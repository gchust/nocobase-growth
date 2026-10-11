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
      || !facts.seo || !Array.isArray(facts.seo.daily) || !Array.isArray(facts.evidence)
      || !facts.site_checks || !Array.isArray(facts.site_checks.findings)) throw new SafeError('REPORT_FACTS_INVALID');
  if (facts.sources.find(s => s.id === 'gsc')?.status !== 'ok'
      && facts.sources.find(s => s.id === 'gsc')?.status !== 'partial') throw new SafeError('REPORT_GSC_UNAVAILABLE');
  const ids = facts.evidence.map(e => e.id);
  if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new SafeError('REPORT_EVIDENCE_INVALID');
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
