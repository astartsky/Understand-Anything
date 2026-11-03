import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helpers = [
  '../understand/analysis-context.mjs',
  '../understand-chat/graph-context.mjs',
  '../understand-dashboard/dashboard-context.mjs',
  '../understand-diff/diff-context.mjs',
  '../understand-domain/domain-context.mjs',
  '../understand-domain/validate-domain.mjs',
  '../understand-onboard/onboard-context.mjs',
];

for (const relative of helpers) {
  const url = new URL(relative, import.meta.url);
  test(`${relative}: stdin import has no CLI side effects`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: `await import(${JSON.stringify(url.href)});`, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
  test(`${relative}: symlink remains a working CLI`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ua-entrypoint-'));
    try {
      const entry = join(dir, 'entry.mjs');
      symlinkSync(fileURLToPath(url), entry);
      const result = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
      if (relative.includes('dashboard-context')) {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /^understand-dashboard:/);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Usage:/i);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
