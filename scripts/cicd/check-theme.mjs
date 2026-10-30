import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

// Historic findings remain visible. New errors are blocking; existing product code is not rewritten here.
const baseline = 'aca32ad';
const current = 'themes/kpurpleshoes-theme';
function check(root) {
  const result = spawnSync('shopify', ['theme', 'check', '--path', root, '--output', 'json', '--fail-level', 'error'],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, shell: process.platform === 'win32' });
  if (![0, 1].includes(result.status)) throw Error('Theme Check did not complete');
  const start = result.stdout.indexOf('[{"path"');
  let data;
  try { data = JSON.parse(result.stdout.slice(start)); } catch { throw Error('Theme Check returned no valid findings'); }
  const findings = new Map();
  for (const file of data) for (const o of file.offenses) if (o.severity === 'error') {
    const key = [relative(root, file.path).replaceAll('\\', '/'), o.check, o.message].join(': ');
    findings.set(key, (findings.get(key) || 0) + 1);
  }
  return findings;
}
const temp = mkdtempSync(join(tmpdir(), 'ps-theme-check-'));
try {
  const archive = join(temp, 'baseline.tar');
  execFileSync('git', ['archive', '--output', archive, `${baseline}:${current}`]);
  mkdirSync(join(temp, 'baseline'));
  execFileSync('tar', ['-xf', archive, '-C', join(temp, 'baseline')]);
  const known = check(join(temp, 'baseline')), now = check(current);
  const added = [...now].filter(([key, count]) => count > (known.get(key) || 0));
  console.log(`Theme Check: ${[...now.values()].reduce((a,b) => a+b, 0)} existing/current errors; ${added.length} new error groups.`);
  if (added.length) { for (const [key] of added) console.error(key); process.exitCode = 1; }
} finally { rmSync(temp, { recursive: true, force: true }); }
