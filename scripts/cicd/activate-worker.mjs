// Runs only on a verified replacement instance through SSM. Never logs credentials or customer data.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const [prior, next] = process.argv.slice(2);
if (![prior, next].every(s => /^[a-f0-9]{64}$/.test(s || ''))) throw Error('Invalid release digest');
const root = fs.realpathSync('/opt/purpleshoes/current');
for (const line of fs.readFileSync('/etc/purpleshoes/fleet.env', 'utf8').trim().split('\n')) {
  const i = line.indexOf('='); if (i > 0) process.env[line.slice(0, i)] = line.slice(i+1);
}
if (![prior, next].includes(process.env.RELEASE_SHA)) throw Error('Wrong runtime release');
const req = createRequire(root + '/package.json');
const { SecretsManagerClient, GetSecretValueCommand } = req('@aws-sdk/client-secrets-manager');
const { PrismaClient } = req('@prisma/client');
const sm = new SecretsManagerClient({ region: process.env.AWS_REGION, maxAttempts: 2 });
let db;
try {
  const ready = await fetch('http://127.0.0.1:3000/v1/ready', { signal: AbortSignal.timeout(5000) });
  if (ready.status !== 200) throw Error('Not ready');
  const secret = await sm.send(new GetSecretValueCommand({ SecretId: process.env.DATABASE_SECRET_ARN, VersionStage: 'AWSCURRENT' }));
  const username = JSON.parse(secret.SecretString).username;
  const launcher = fs.readFileSync('/opt/purpleshoes/bin/start-fleet.mjs', 'utf8');
  const suffix = launcher.match(/encodeURIComponent\(username\)\+'(@[^']+)'/)?.[1];
  if (!suffix || !username) throw Error('Unrecognized database launcher');
  const { databaseUrlWithSecret } = await import(pathToFileURL(root + '/scripts/managed-database.mjs'));
  const { databaseUrlWithVerifiedTls } = await import(pathToFileURL(root + '/scripts/database-tls.mjs'));
  const url = 'postgresql://' + encodeURIComponent(username) + suffix;
  db = new PrismaClient({ datasourceUrl: databaseUrlWithVerifiedTls(databaseUrlWithSecret(url, secret.SecretString)), log: [] });
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
    const rows = await tx.$queryRawUnsafe("SELECT source_digest,details FROM fleet_state_migrations WHERE id='fleet-active-v1' FOR UPDATE");
    if (rows.length !== 1 || ![prior, next].includes(rows[0].source_digest) || rows[0].details?.state !== 'TRAFFIC_ACTIVE_OLD_WORKER_STOPPED') throw Error('Unexpected worker gate');
    if (rows[0].source_digest !== next) {
      const n = await tx.$executeRawUnsafe("UPDATE fleet_state_migrations SET source_digest=$1 WHERE id='fleet-active-v1' AND source_digest=$2", next, prior);
      if (n !== 1) throw Error('Worker gate was not updated');
    }
  });
  console.log('PURCHASE_WORKER_GATE_VERIFIED');
} catch { console.error('Purchase worker activation failed; sensitive details suppressed'); process.exitCode = 1; }
finally { await db?.$disconnect(); sm.destroy(); }
