import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import assert from 'node:assert/strict';

export const tracked = () => execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
export const jsonText = text => text.replace(/^\s*\/\*[\s\S]*?\*\//, '').trim();
export function verify(files = tracked()) {
  for (const file of files) {
    assert(!file.split('/').includes('..') && !file.startsWith('/'), `Unsafe path: ${file}`);
    assert(!lstatSync(file).isSymbolicLink(), `Tracked symlink: ${file}`);
    assert(!/(^|\/)(\.env(?:\..*)?|\.npmrc|\.aws|credentials)(\/|$)/.test(file) || file.endsWith('/.env.example'), `Private file: ${file}`);
    assert(!/\.(p12|pfx|key|sqlite|db|tgz)$/.test(file), `Private/generated file: ${file}`);
    if (file.startsWith('themes/') && file.endsWith('.json')) JSON.parse(jsonText(readFileSync(file, 'utf8')));
    if (file.startsWith('themes/') && file.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  }
  console.log(`Verified ${files.length} tracked files; no application or database started.`);
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/verify-source.mjs')) verify();
