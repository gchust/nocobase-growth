/** Pure date and comparison helpers. Ratios are stored as fractions, not percent. */
export function assertIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError('INVALID_DATE');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError('INVALID_DATE');
  }
  return value;
}

export function dateInTimeZone(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('INVALID_DATE');
  const parts = new Intl.DateTimeFormat('en', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return assertIsoDate(`${part('year')}-${part('month')}-${part('day')}`);
}

export function shiftDate(value, days) {
  assertIsoDate(value);
  if (!Number.isInteger(days)) throw new TypeError('INVALID_DAY_OFFSET');
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return assertIsoDate(date.toISOString().slice(0, 10));
}

export function daysBetween(startDate, endDate) {
  assertIsoDate(startDate);
  assertIsoDate(endDate);
  return (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000;
}

export function datesInPeriod(startDate, endDate) {
  const days = daysBetween(startDate, endDate);
  if (days < 0 || days > 10000) throw new TypeError('INVALID_PERIOD');
  return Array.from({ length: days + 1 }, (_, index) => shiftDate(startDate, index));
}

export function comparisonPeriods(endDate, length) {
  assertIsoDate(endDate);
  if (!Number.isInteger(length) || length < 1 || length > 10000) {
    throw new TypeError('INVALID_PERIOD');
  }
  return {
    current_period: { start_date: shiftDate(endDate, 1 - length), end_date: endDate },
    previous_period: {
      start_date: shiftDate(endDate, 1 - 2 * length),
      end_date: shiftDate(endDate, -length),
    },
  };
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function metricChange(currentValue, previousValue) {
  const current = finiteOrNull(currentValue);
  const previous = finiteOrNull(previousValue);
  const absolute = current === null || previous === null ? null : current - previous;
  const relative = absolute === null || previous === 0 ? null : absolute / previous;
  return {
    current,
    previous,
    absolute_change: finiteOrNull(absolute),
    relative_change: finiteOrNull(relative),
  };
}

export function compareTotals(periods, current, previous, metricNames) {
  return {
    current_period: { ...periods.current_period },
    previous_period: { ...periods.previous_period },
    metrics: Object.fromEntries(metricNames.map((name) => [
      name, metricChange(current?.[name], previous?.[name]),
    ])),
  };
}

/** Missing top-row observations remain null; absence never means zero traffic. */
export function buildMovers(currentRows, previousRows, {
  limit = 20,
  evidenceIds = [],
} = {}) {
  const current = new Map(currentRows.map(({ key, ...metrics }) => [key, metrics]));
  const previous = new Map(previousRows.map(({ key, ...metrics }) => [key, metrics]));
  const keys = new Set([...current.keys(), ...previous.keys()]);
  return [...keys].map((key) => {
    const currentMetrics = current.get(key) ?? null;
    const previousMetrics = previous.get(key) ?? null;
    return {
      key,
      current: currentMetrics,
      previous: previousMetrics,
      click_change: metricChange(currentMetrics?.clicks, previousMetrics?.clicks).absolute_change,
      evidence_ids: [...evidenceIds],
    };
  }).sort((a, b) => {
    const strength = (row) => row.click_change === null
      ? Math.max(row.current?.clicks ?? 0, row.previous?.clicks ?? 0)
      : Math.abs(row.click_change);
    const difference = strength(b) - strength(a);
    if (difference !== 0) return difference;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  }).slice(0, limit);
}
