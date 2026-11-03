import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dashboardContext } from './dashboard-context.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ua-dashboard-context-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  writeFileSync(join(root, 'code.js'), 'export const a = 1;\n');
  git('add', '.');
  git('-c', 'user.name=Dashboard Test', '-c', 'user.email=dashboard@example.test', 'commit', '-qm', 'baseline');
  const hash = git('rev-parse', 'HEAD');
  function graph(file = 'domain-graph.json', project = {}, dir = '.ua') {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, file), JSON.stringify({ project: { sourceRoot: root, gitCommitHash: hash, workingTreeDirty: false, ...project }, nodes: [], edges: [] }));
  }
  return { root, graph, git, hash };
}

test('accepts domain-only graphs without creating or loading a runtime', t => {
  const { root, graph } = fixture(t); graph();
  const context = dashboardContext(root);
  assert.equal(context.graphs.length, 1);
  assert.match(context.graphs[0].path, /domain-graph.json$/);
  assert.deepEqual(context.warnings, []);
  assert.equal(existsSync(join(root, 'node_modules')), false);
});

test('rejects nonexistent projects without writing into caller cwd', t => {
  const { root } = fixture(t);
  assert.throws(() => dashboardContext('missing', root), /ENOENT/);
  assert.equal(existsSync(join(root, 'node_modules')), false);
  assert.equal(existsSync(join(root, '.ua')), false);
});

test('legacy existence selects one directory even when empty', t => {
  const { root, graph } = fixture(t); graph();
  mkdirSync(join(root, '.understand-anything'));
  assert.throws(() => dashboardContext(root), /No knowledge or domain graph found/);
});

test('does not merge graph files across legacy and new directories', t => {
  const { root, graph } = fixture(t);
  graph(); graph('knowledge-graph.json', {}, '.understand-anything');
  const context = dashboardContext(root);
  assert.equal(context.graphs.length, 1);
  assert.match(context.graphs[0].path, /\.understand-anything\/knowledge-graph.json$/);
});

test('warns copied source and unknown analysis state despite equal HEAD', t => {
  const { root, graph } = fixture(t);
  graph('domain-graph.json', { sourceRoot: '/another/checkout', workingTreeDirty: true });
  assert.match(dashboardContext(root).warnings.join('\n'), /source checkout differs/);
  assert.match(dashboardContext(root).warnings.join('\n'), /analysis working-tree state/);
});

test('warns stale commit and current working-tree changes', t => {
  const { root, graph } = fixture(t);
  graph('knowledge-graph.json', { gitCommitHash: 'a'.repeat(40) });
  writeFileSync(join(root, 'new.js'), 'untracked\n');
  const warnings = dashboardContext(root).warnings.join('\n');
  assert.match(warnings, /uncommitted changes/);
  assert.match(warnings, /analysis commit differs/);
});

test('accepts a matching metadata source binding for a legacy graph', t => {
  const { root, graph, hash } = fixture(t);
  graph('knowledge-graph.json', { sourceRoot: undefined, workingTreeDirty: undefined });
  writeFileSync(join(root, '.ua', 'meta.json'), JSON.stringify({ sourceRoot: root, gitCommitHash: hash, workingTreeDirty: false }));
  assert.deepEqual(dashboardContext(root).warnings, []);
});

test('rejects invalid graph JSON but treats broken optional metadata as a warning', t => {
  const { root, graph } = fixture(t); graph();
  writeFileSync(join(root, '.ua', 'meta.json'), '{bad');
  assert.match(dashboardContext(root).warnings.join('\n'), /Invalid or unreadable JSON/);
  writeFileSync(join(root, '.ua', 'domain-graph.json'), '{bad');
  assert.throws(() => dashboardContext(root), /Invalid or unreadable JSON/);
});
