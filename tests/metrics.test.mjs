import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertIsoDate, dateInTimeZone, shiftDate, daysBetween,
  comparisonPeriods, metricChange, compareTotals, buildMovers,
} from '../src/metrics.mjs';

test('source dates respect Pacific midnight and DST rather than the report timezone', () => {
  const beforeMidnight = new Date('2026-03-08T07:59:00Z');
  assert.equal(dateInTimeZone(beforeMidnight, 'America/Los_Angeles'), '2026-03-07');
  assert.equal(dateInTimeZone(beforeMidnight, 'Asia/Shanghai'), '2026-03-08');
  assert.equal(dateInTimeZone(new Date('2026-03-08T08:00:00Z'), 'America/Los_Angeles'), '2026-03-08');
  assert.equal(dateInTimeZone(new Date('2026-03-09T07:00:00Z'), 'America/Los_Angeles'), '2026-03-09');
  assert.equal(shiftDate('2026-03-09', -1), '2026-03-08');
});

test('seven and 28 day comparisons are inclusive, equally sized, and non-overlapping', () => {
  assert.deepEqual(comparisonPeriods('2026-10-08', 7), {
    current_period: { start_date: '2026-10-02', end_date: '2026-10-08' },
    previous_period: { start_date: '2026-09-25', end_date: '2026-10-01' },
  });
  assert.deepEqual(comparisonPeriods('2026-10-08', 28), {
    current_period: { start_date: '2026-09-11', end_date: '2026-10-08' },
    previous_period: { start_date: '2026-08-14', end_date: '2026-09-10' },
  });
  const leap = comparisonPeriods('2024-03-03', 7);
  assert.equal(leap.current_period.start_date, '2024-02-26');
  assert.equal(daysBetween(leap.current_period.start_date, leap.current_period.end_date) + 1, 7);
  assert.throws(() => assertIsoDate('2026-02-29'), /INVALID_DATE/);
  assert.throws(() => assertIsoDate('2026-2-03'), /INVALID_DATE/);
});

test('zero baselines and unknown observations never produce fabricated percentages', () => {
  assert.deepEqual(metricChange(20, 10), {
    current: 20, previous: 10, absolute_change: 10, relative_change: 1,
  });
  assert.deepEqual(metricChange(10, 0), {
    current: 10, previous: 0, absolute_change: 10, relative_change: null,
  });
  assert.deepEqual(metricChange(0, 0), {
    current: 0, previous: 0, absolute_change: 0, relative_change: null,
  });
  assert.deepEqual(metricChange(null, 10), {
    current: null, previous: 10, absolute_change: null, relative_change: null,
  });
  assert.equal(metricChange(Infinity, 10).current, null);
});

test('comparison totals preserve the range query values and fraction precision', () => {
  const comparison = compareTotals(comparisonPeriods('2026-10-08', 7),
    { clicks: 123, ctr: 0.123456789 }, { clicks: 100, ctr: 0.1 }, ['clicks', 'ctr']);
  assert.equal(comparison.metrics.clicks.current, 123);
  assert.equal(comparison.metrics.ctr.current, 0.123456789);
  assert.ok(Math.abs(comparison.metrics.ctr.absolute_change - 0.023456789) < 1e-12);
});

test('a page absent from one top-row result remains unobserved instead of a 100% loss', () => {
  const rows = buildMovers(
    [{ key: '/shared', clicks: 8 }, { key: '/new-observation', clicks: 20 }],
    [{ key: '/shared', clicks: 10 }, { key: '/old-observation', clicks: 30 }],
    { evidenceIds: ['current-query', 'previous-query'] },
  );
  const shared = rows.find((row) => row.key === '/shared');
  assert.equal(shared.click_change, -2);
  const old = rows.find((row) => row.key === '/old-observation');
  assert.equal(old.current, null);
  assert.equal(old.click_change, null);
  assert.deepEqual(old.evidence_ids, ['current-query', 'previous-query']);
  assert.equal(rows.find((row) => row.key === '/new-observation').previous, null);
});
