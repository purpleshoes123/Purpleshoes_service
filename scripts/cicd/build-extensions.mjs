// Credential-free PR compilation. Shopify's authenticated schema validation runs before app release.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve('shopify/bta-proxy');
// This entry point is invoked from the extension workspace by CI.
const appRoot = process.cwd().replaceAll('\\', '/').endsWith('/shopify/bta-proxy') ? process.cwd() : root;
const req = createRequire(resolve(appRoot, 'package.json'));
const { build } = req('esbuild');
const python = `
import json, pathlib, tomllib, sys
root = pathlib.Path(sys.argv[1])
entries, uids = [], set()
required = {'admin-guide-entitlement-panel', 'admin-order-booking-link', 'checkout-tour-booking-summary', 'post-purchase-confirmation'}
folders = {p.name for p in (root/'extensions').iterdir() if p.is_dir()}
assert required <= folders, 'An existing production extension is missing'
for folder in sorted(folders):
 config = root/'extensions'/folder/'shopify.extension.toml'
 if not config.exists(): continue
 obj = tomllib.loads(config.read_text(encoding='utf-8'))
 for extension in obj['extensions']:
  assert extension['uid'] not in uids, 'Duplicate extension UID'
  uids.add(extension['uid'])
  for target in extension['targeting']:
   module = (config.parent/target['module']).resolve()
   assert module.is_relative_to(config.parent.resolve()) and module.is_file()
   entries.append({'name':folder, 'path':str(module)})
print(json.dumps(entries))
`;
const modules = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', python, appRoot], { encoding: 'utf8' }));
for (const item of modules) {
  await build({ entryPoints: [item.path], bundle: true, format: 'iife', globalName: 'extension',
    jsx: 'automatic', jsxImportSource: 'preact', target: 'es2022',
    define: { 'process.env.NODE_ENV': '"production"' },
    outfile: resolve(appRoot, '../../output/cicd/extensions', item.name + '.js') });
}
console.log(`Compiled ${modules.length} extension targets without production credentials.`);
