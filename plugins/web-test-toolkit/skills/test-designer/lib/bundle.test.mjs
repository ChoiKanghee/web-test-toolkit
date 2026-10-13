import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleDir, hostOf } from './bundle.mjs';

function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('hostOf sanitizes the port so localhost:3000 maps to localhost_3000', (t) => {
  withEnv(t, { WEBTEST_HOST: undefined });
  assert.equal(hostOf('http://localhost:3000/login'), 'localhost_3000');
});

test('WEBTEST_HOST overrides the derived host and is sanitized too', (t) => {
  withEnv(t, { WEBTEST_HOST: 'custom:8080' });
  assert.equal(hostOf('https://example.com'), 'custom_8080');
});

test('bundleDir is artifacts/<host> with forward slashes', (t) => {
  withEnv(t, { WEBTEST_HOST: undefined });
  assert.equal(bundleDir('https://example.com/a'), 'artifacts/example.com');
});
