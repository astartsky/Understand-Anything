import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSourceCommit } from '../../../understand-anything-plugin/skills/understand/analysis-context.mjs';
import { prepareContext } from '../../../understand-anything-plugin/skills/understand-domain/domain-context.mjs';
import { dashboardContext } from '../../../understand-anything-plugin/skills/understand-dashboard/dashboard-context.mjs';
import { collectContext } from '../../../understand-anything-plugin/skills/understand-diff/diff-context.mjs';

const fixtures = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-freshness-consumer-')));
  fixtures.push(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), '.ua/\n.understand-anything/\n');
  writeFileSync(join(root, 'orders.ts'), 'export const orders = 1;\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline');
  const hash = git('rev-parse', 'HEAD');
  const project = { sourceRoot: root, gitCommitHash: hash, workingTreeDirty: false };
  mkdirSync(join(root, '.ua'));
  writeFileSync(join(root, '.ua', 'knowledge-graph.json'), JSON.stringify({
    project, nodes: [{ id: 'orders', name: 'Orders', type: 'service', filePath: 'orders.ts' }], edges: [], layers: [],
  }));
  writeFileSync(join(root, '.ua', 'meta.json'), JSON.stringify(project));
  writeFileSync(join(root, '.ua', 'fingerprints.json'), JSON.stringify({ gitCommitHash: hash }));
  return { root, hash };
}

describe('graph freshness consumers use read-only Git inspection', () => {
  const readers = [
    ['analysis preflight', ({ root, hash }) => assertSourceCommit(root, hash)],
    ['domain preflight', ({ root }) => prepareContext([root])],
    ['dashboard preflight', ({ root }) => dashboardContext(root)],
    ['diff collection', ({ root }) => collectContext({ sourceRoot: root })],
  ];
  it.each(readers)('%s preserves the Git index even when stat data needs refresh', (_, inspect) => {
    const f = fixture();
    const index = join(f.root, '.git', 'index');
    const before = readFileSync(index);
    // Same bytes, stale filesystem timestamps: ordinary git status/diff refresh the index.
    utimesSync(join(f.root, 'orders.ts'), 1234567890, 1234567890);
    inspect(f);
    expect(readFileSync(index)).toEqual(before);
    expect(readFileSync(join(f.root, 'orders.ts'), 'utf8')).toBe('export const orders = 1;\n');
  });

  it('domain regenerates stale or dirty input instead of reusing it with only a warning', () => {
    const { root } = fixture();
    expect(prepareContext([root]).mode).toBe('graph');
    writeFileSync(join(root, 'orders.ts'), 'export const orders = 2;\n');
    expect(prepareContext([root]).mode).toBe('scan');
    expect(prepareContext([root, '--full']).mode).toBe('scan');
  });

  it('viewing and diffing preserve warnings and actual untracked changes', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'new service.ts'), 'export const pending = true;\n');
    expect(dashboardContext(root).warnings.join('\n')).toMatch(/uncommitted changes/);
    const diff = collectContext({ sourceRoot: root });
    expect(diff.changeSources.untracked).toEqual(['new service.ts']);
    expect(diff.unmappedFiles).toEqual(['new service.ts']);
    expect(diff.warnings.join('\n')).toMatch(/changed source files/);
  });
});
