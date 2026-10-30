import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveManagedAppRuntime } from './managed-app-runtime.mjs';
import { RUNTIME_KEYS } from './app-runtime-settings.mjs';

const env = {
  DEPLOYMENT_MODE: 'multi-node', FLEET_STAGE: 'prelive',
  APP_RUNTIME_SECRET_ARN: 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:purpleshoes/prod/app-runtime-Ab1234',
  DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:rds!db-fixture',
  APP_RUNTIME_SECRET_VERSION: ['01234567', '89ab', 'cdef', '0123', '456789abcdef'].join('-'),
  DATABASE_URL: 'postgresql://fixture', REDIS_URL: 'rediss://fixture', RELEASE_SHA: 'a'.repeat(40),
};
const settings = Object.fromEntries(RUNTIME_KEYS.map(key => [key, 'fixture-only']));
Object.assign(settings, { PURCHASE_EMAIL_ENABLED: 'true', PURCHASE_SERVICE_EMAIL_ENABLED: 'true',
  KLAVIYO_MAIL_EVENT_ENABLED: 'true', KLAVIYO_PURCHASE_EVENT_ENABLED: 'true' });
const response = (overrides = {}) => ({ ARN: env.APP_RUNTIME_SECRET_ARN,
  VersionId: env.APP_RUNTIME_SECRET_VERSION, VersionStages: ['AWSCURRENT'],
  SecretString: JSON.stringify(settings), ...overrides });
const error = { message: 'Managed application runtime configuration failed' };

test('legacy startup has no secret call or behavior changes', async () => {
  const original = { PURCHASE_EMAIL_ENABLED: 'true' };
  const result = await resolveManagedAppRuntime({env: original, readSecret: () => assert.fail()});
  assert.deepEqual(result, original); assert.notEqual(result, original);
});
test('loads pinned version, preserves infrastructure settings, never mutates input', async () => {
  const before = {...env}; let calls = 0;
  const result = await resolveManagedAppRuntime({env, readSecret: async (id, version) => {
    calls++; assert.equal(id,env.APP_RUNTIME_SECRET_ARN); assert.equal(version,env.APP_RUNTIME_SECRET_VERSION);
    return response();
  }});
  assert.equal(calls, 1); assert.equal(result.SHOPIFY_API_SECRET, 'fixture-only');
  for (const key of ['DATABASE_URL','REDIS_URL','RELEASE_SHA']) assert.equal(result[key], env[key]);
  assert.deepEqual(env,before);
  for (const key of ['PURCHASE_EMAIL_ENABLED','PURCHASE_SERVICE_EMAIL_ENABLED','KLAVIYO_MAIL_EVENT_ENABLED','KLAVIYO_PURCHASE_EVENT_ENABLED','REBUILD_AUTO_ON_STARTUP','REBUILD_AUTO_IF_EMPTY']) assert.equal(result[key],'false');
});
test('explicit active stage preserves mail flags but never enables automatic rebuild', async () => {
  const result = await resolveManagedAppRuntime({env:{...env,FLEET_STAGE:'active',REBUILD_AUTO_ON_STARTUP:'true'}, backgroundJob:true, readSecret: async () => response()});
  assert.equal(result.PURCHASE_EMAIL_ENABLED,'true'); assert.equal(result.REBUILD_AUTO_ON_STARTUP,'false');
});

test('private checkout is opt-in and follows the pinned runtime setting', async () => {
  for (const flag of [undefined, 'false', 'true']) {
    const configured = { ...settings };
    delete configured.BTA_PRIVATE_CHECKOUT_ENABLED;
    if (flag !== undefined) configured.BTA_PRIVATE_CHECKOUT_ENABLED = flag;
    const result = await resolveManagedAppRuntime({
      env: { ...env, FLEET_STAGE: 'active' },
      readSecret: async () => response({ SecretString: JSON.stringify(configured) }),
    });
    assert.equal(result.BTA_PRIVATE_CHECKOUT_ENABLED, flag);
  }
});
test('prelive background job is blocked before reading any secret', async () => {
  await assert.rejects(resolveManagedAppRuntime({env,backgroundJob:true,readSecret:()=>assert.fail()}),error);
});
for (const change of [
  {APP_RUNTIME_SECRET_ARN:undefined}, {APP_RUNTIME_SECRET_VERSION:undefined},
  {APP_RUNTIME_SECRET_VERSION:'AWSCURRENT'}, {FLEET_STAGE:undefined}, {FLEET_STAGE:'Active'},
  {DATABASE_SECRET_ARN:env.DATABASE_SECRET_ARN.replace('123456789012','999999999999')},
  {DATABASE_SECRET_ARN:env.DATABASE_SECRET_ARN.replace('ap-northeast-2','us-east-1')},
  {DEPLOYMENT_MODE:'single-node'},
]) test(`rejects invalid fleet bootstrap ${JSON.stringify(change)}`, async () => {
  await assert.rejects(resolveManagedAppRuntime({env:{...env,...change},readSecret:()=>assert.fail()}),error);
});
for (const change of [
  {ARN:'wrong'}, {VersionId:'wrong'}, {VersionStages:['AWSPREVIOUS']},
  {SecretString:undefined}, {SecretString:'private-invalid-json'}, {SecretString:'{}'},
  {SecretString:'[]'}, {SecretString:'null'},
  ...['NODE_OPTIONS','DATABASE_URL','REDIS_URL','AWS_SECRET_ACCESS_KEY','FLEET_STAGE','__proto__'].map(key => ({SecretString:JSON.stringify({...settings,[key]:'private-fixture'})})),
  {SecretString:JSON.stringify({...settings,SMTP_PASSWORD:42})},
]) test(`rejects invalid secret shape ${Object.keys(change).join(',')} ${JSON.stringify(change).slice(0,40)}`, async () => {
  await assert.rejects(resolveManagedAppRuntime({env,readSecret:async()=>response(change)}),error);
});
test('SDK failures do not disclose secret values or exception details', async () => {
  await assert.rejects(resolveManagedAppRuntime({env,readSecret:async()=>{throw new Error('private-fixture-token');}}),error);
});
