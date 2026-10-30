import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { errorCounts } from './check-theme.mjs';

test('CLI 5 issue objects are read and warnings do not become blocking errors', () => {
  const issue = { filePath: resolve('theme/sections/example.liquid'), check: 'SyntaxError', message: 'invalid Liquid', severity: 'error', startRow: 1 };
  const data = { valid: false, issues: [issue, { ...issue, startRow: 20 }, { ...issue, severity: 'warning' }] };
  assert.deepEqual([...errorCounts(data, 'theme')], [['sections/example.liquid: SyntaxError: invalid Liquid', 2]]);
});
test('Unknown or empty CLI output cannot silently pass validation', () => {
  assert.throws(() => errorCounts({}, 'theme'), /Unknown/);
  assert.throws(() => errorCounts([], 'theme'), /Unknown/);
  assert.equal(errorCounts({ valid: true, issues: [] }, 'theme').size, 0);
});
