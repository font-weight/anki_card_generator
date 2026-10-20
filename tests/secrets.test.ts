import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretVault, SecretStorageError } from '../packages/services/src/secrets.ts';
import type { SecretStorageArea } from '../packages/services/src/secrets.ts';

function storageArea(): SecretStorageArea & { values: Record<string, unknown>; access: string[] } {
  const values: Record<string, unknown> = {};
  const access: string[] = [];
  return {
    values, access,
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, values[key]])); },
    async set(items) { Object.assign(values, items); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
    async setAccessLevel(options) { access.push(options.accessLevel); },
  };
}
const key = 'unit-test-credential-not-a-real-key';

test('secrets default to session, never sync, and restrict both areas', async () => {
  const session = storageArea(), local = storageArea();
  const vault = new SecretVault({ session, local });
  await vault.setOpenAIKey(key);
  assert.deepEqual(session.access, ['TRUSTED_CONTEXTS']);
  assert.deepEqual(local.access, ['TRUSTED_CONTEXTS']);
  assert.equal(Object.values(session.values)[0], key);
  assert.deepEqual(local.values, {});
  assert.equal(await vault.getOpenAIKeyForService(), key);
  assert.deepEqual(await vault.status(), { hasOpenAIKey: true, hasAnkiConnectKey: false, openAIStorage: 'session', ankiConnectStorage: null });
  assert.ok(!JSON.stringify(await vault.status()).includes(key));
});

test('persistence is explicit opt-in and switching back removes local copy', async () => {
  const session = storageArea(), local = storageArea();
  const vault = new SecretVault({ session, local });
  await vault.setOpenAIKey(key, { persist: true });
  assert.equal(Object.values(local.values)[0], key);
  assert.deepEqual(session.values, {});
  assert.equal((await vault.status()).openAIStorage, 'local');
  await vault.setOpenAIKey('another-unit-test-key');
  assert.deepEqual(local.values, {});
  assert.equal(await vault.getOpenAIKeyForService(), 'another-unit-test-key');
});

test('AnkiConnect secret has independent storage and clearing', async () => {
  const session = storageArea(), local = storageArea();
  const vault = new SecretVault({ session, local });
  await vault.setOpenAIKey(key);
  await vault.setAnkiConnectKey('anki-unit-key', { persist: true });
  assert.equal(await vault.getAnkiConnectKeyForService(), 'anki-unit-key');
  await vault.clearAnkiConnectKey();
  assert.equal(await vault.getAnkiConnectKeyForService(), null);
  assert.equal(await vault.getOpenAIKeyForService(), key);
});

test('clear removes both stale copies, not unrelated extension settings', async () => {
  const session = storageArea(), local = storageArea();
  const vault = new SecretVault({ session, local });
  await vault.setOpenAIKey(key, { persist: true });
  session.values['englishReader.secret.openai.v1'] = 'stale-unit-key';
  local.values.theme = 'dark';
  await vault.clearOpenAIKey();
  assert.deepEqual(local.values, { theme: 'dark' });
  assert.deepEqual(session.values, {});
  assert.equal(await vault.getOpenAIKeyForService(), null);
});

test('no session API fails closed, without persistent fallback', async () => {
  const local = storageArea();
  const vault = new SecretVault({ local });
  await assert.rejects(vault.setOpenAIKey(key), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(local.values, {});
});

test('TRUSTED_CONTEXTS rejection prevents reading or saving secrets', async () => {
  const session = storageArea(), local = storageArea();
  local.setAccessLevel = async () => { throw new Error(key); };
  const vault = new SecretVault({ session, local });
  await assert.rejects(vault.setOpenAIKey(key), error => {
    assert.equal((error as SecretStorageError).code, 'PERMISSION_DENIED');
    assert.ok(!String(error).includes(key));
    return true;
  });
  assert.deepEqual(session.values, {});
});

test('old runtime without local access-level API permits session only', async () => {
  const session = storageArea(), local = storageArea();
  delete local.setAccessLevel;
  const vault = new SecretVault({ session, local });
  await vault.setOpenAIKey(key);
  await assert.rejects(vault.setOpenAIKey(key, { persist: true }), { code: 'PERMISSION_DENIED' });
  assert.equal(await vault.getOpenAIKeyForService(), key);
});

test('errors never interpolate rejected credential or storage exception', async () => {
  const session = storageArea(), local = storageArea();
  const vault = new SecretVault({ session, local });
  await assert.rejects(vault.setOpenAIKey('secret\ninput'), error => !String(error).includes('secret'));
  session.set = async () => { const error = new Error(`quota for ${key}`); error.name = 'QuotaExceededError'; throw error; };
  await assert.rejects(vault.setOpenAIKey(key), error => {
    assert.equal((error as SecretStorageError).code, 'STORAGE_QUOTA');
    assert.ok(!String(error).includes(key)); return true;
  });
});

test('mutations serialize and a failed write does not poison subsequent clear', async () => {
  const session = storageArea(), local = storageArea();
  const vault = new SecretVault({ session, local });
  await Promise.all([vault.setOpenAIKey(key), vault.clearOpenAIKey()]);
  assert.equal(await vault.getOpenAIKeyForService(), null);
  session.set = async () => { throw new Error('failed'); };
  await assert.rejects(vault.setOpenAIKey(key));
  await vault.clearOpenAIKey();
  assert.equal((await vault.status()).hasOpenAIKey, false);
});

test('partial clear failure attempts both areas and returns safe failure', async () => {
  const session = storageArea(), local = storageArea();
  const vault = new SecretVault({ session, local });
  await vault.setOpenAIKey(key, { persist: true });
  session.remove = async () => { throw new Error(key); };
  await assert.rejects(vault.clearOpenAIKey(), { code: 'PERMISSION_DENIED' });
  assert.deepEqual(local.values, {});
});

test('non-quota storage failure is not misreported as quota', async () => {
  const session = storageArea(), local = storageArea();
  session.set = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(new SecretVault({ session, local }).setOpenAIKey(key), { code: 'STORAGE_UNAVAILABLE' });
});
