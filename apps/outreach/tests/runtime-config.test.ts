import test from 'node:test';
import assert from 'node:assert/strict';
import { storageConfiguration } from '../server/runtime-config.js';

test('Archil startup requires an explicit nonempty disk ID before constructing providers', () => {
  for (const env of [{}, { ARCHIL_DISK_ID: '' }, { ARCHIL_DISK_ID: '  ' }, { APP_STORAGE: 'invalid' }]) {
    assert.throws(() => storageConfiguration(env), /ARCHIL_DISK_ID is required.*APP_STORAGE=file/);
  }
  assert.deepEqual(storageConfiguration({ ARCHIL_DISK_ID: ' dsk-test-outreach ', ARCHIL_PREFIX: 'test-prefix' }), {
    localStorage: false, diskId: 'dsk-test-outreach', storagePrefix: 'test-prefix/',
  });
});

test('explicit local test storage does not invent or require an Archil disk', () => {
  assert.deepEqual(storageConfiguration({ APP_STORAGE: 'file' }), {
    localStorage: true, diskId: '', storagePrefix: 'autonomous-sourcing/v1/',
  });
  assert.equal(storageConfiguration({ APP_STORAGE: 'file', ARCHIL_DISK_ID: 'dsk-test-explicit' }).diskId, 'dsk-test-explicit');
});
