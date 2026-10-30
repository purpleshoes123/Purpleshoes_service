import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { tracked } from './verify-source.mjs';

const root = 'output/cicd/runtime';
const prefix = 'apps/bta-proxy/';
const files = {};
for (const file of tracked().filter(f => f.startsWith(prefix)).sort()) {
  const name = file.slice(prefix.length);
  if (!/^(app\/|public\/|prisma\/|scripts\/|mail-templates\/|certs\/|package(?:-lock)?\.json$|vite\.config\.ts$|react-router\.config\.ts$|tsconfig\.json$|env\.d\.ts$)/.test(name)) continue;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || name.startsWith('prisma/migrations/')) continue;
  if (name.split('/').some(p => p.startsWith('.'))) throw Error('Hidden runtime source');
  const content = readFileSync(file);
  files[name] = { sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length };
  mkdirSync(dirname(`${root}/${name}`), { recursive: true });
  copyFileSync(file, `${root}/${name}`);
}
const source = JSON.stringify({ format: 'purpleshoes-ci-source-v1', commit: process.env.GITHUB_SHA, files }, null, 2) + '\n';
const digest = createHash('sha256').update(source).digest('hex');
writeFileSync(`${root}/FLEET-SOURCE-MANIFEST.json`, source);
writeFileSync(`${root}/FLEET-RELEASE-MANIFEST.json`, JSON.stringify({
  format: 'purpleshoes-linux-release-v1', status: 'PRELIVE_ONLY_NOT_APPROVED_FOR_TRAFFIC',
  sourceManifestSha256: digest, commit: process.env.GITHUB_SHA, node: process.version,
  dataMigrationIncluded: false,
}) + '\n');
