import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const modulePath = fileURLToPath(new URL('./onboard-context.mjs', import.meta.url));
const { onboardContext } = await import(pathToFileURL(modulePath));
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'ua-onboard-tests-')));
after(() => rmSync(temp, { recursive: true, force: true }));
let counter = 0;
function git(root, ...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function fixture(mutate = graph => graph) {
  const root = join(temp, String(counter++)); mkdirSync(root);
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 'tests@example.invalid'); git(root, 'config', 'user.name', 'Local test');
  writeFileSync(join(root, 'main.js'), 'export const main = 1;\n'); git(root, 'add', 'main.js'); git(root, 'commit', '-qm', 'baseline');
  mkdirSync(join(root, '.ua'));
  const files = Array.from({ length: 8 }, (_, i) => ({ id: `file:f${i}.js`, type: 'file', name: `f${i}.js`, filePath: `f${i}.js`, summary: `file ${i}`, complexity: i === 7 ? 'complex' : i === 6 ? 'moderate' : 'simple' }));
  const graph = mutate({ version: '1', project: { name: 'Fixture', description: 'demo', languages: ['js'], frameworks: [], analyzedAt: '2026-11-01T00:00:00Z', gitCommitHash: git(root, 'rev-parse', 'HEAD'), sourceRoot: root, workingTreeDirty: false },
    nodes: [...files,
      { id: 'function:f0.js:run', type: 'function', name: 'run', filePath: 'f0.js', summary: 'fn', complexity: 'complex' },
      { id: 'service:api', type: 'service', name: 'API service', filePath: 'Dockerfile', summary: 'HTTP API container', complexity: 'simple' },
      { id: 'concept:auth', type: 'concept', name: 'Auth', summary: 'token auth', complexity: 'simple' }],
    edges: [
      ...files.filter(f => f.id !== 'file:f5.js').map(f => ({ source: f.id, target: 'file:f5.js', type: 'imports', direction: 'forward', weight: 1 })),
      { source: 'file:f1.js', target: 'file:f2.js', type: 'imports', direction: 'forward', weight: 1 },
      { source: 'file:f0.js', target: 'function:f0.js:run', type: 'contains', direction: 'forward', weight: 1 }],
    layers: [{ id: 'core', name: 'Core', description: 'core logic', nodeIds: [...files.map(f => f.id), 'function:f0.js:run'] },
      { id: 'ops', name: 'Ops', description: 'deploy', nodeIds: ['service:api'] }],
    tour: [{ order: 2, title: 'Second', description: 'b', nodeIds: ['file:f1.js'] }, { order: 1, title: 'First', description: 'a', nodeIds: ['file:f0.js', 'file:gone.js'] }] });
  writeFileSync(join(root, '.ua', 'knowledge-graph.json'), JSON.stringify(graph));
  return { root, graph };
}
const ids = list => list.map(x => x.id);

test('layers expose only top file-level nodes by connectivity and count the rest', () => {
  const { root } = fixture();
  const r = onboardContext(root, { limit: 3 });
  const core = r.layers.find(l => l.id === 'core');
  assert.deepEqual(ids(core.keyNodes), ['file:f5.js', 'file:f0.js', 'file:f1.js']);
  assert.equal(core.nodeCount, 9);
  assert.equal(core.omittedNodes, 6);
  assert.equal('nodes' in r || 'edges' in r, false, 'full graph arrays must not be dumped');
  assert.deepEqual({ nodes: r.counts.nodes, edges: r.counts.edges }, { nodes: 11, edges: 9 });
});

test('runtime parts, concepts and file-level complexity hotspots are bounded', () => {
  const { root } = fixture();
  const r = onboardContext(root, { limit: 2 });
  assert.deepEqual(ids(r.runtimeParts), ['service:api']);
  assert.deepEqual(ids(r.concepts), ['concept:auth']);
  assert.deepEqual(ids(r.hotspots), ['file:f7.js', 'file:f6.js']);
  assert.equal(r.hotspots[0].layer, 'Core');
});

test('tour is ordered, resolves files and reports dangling IDs', () => {
  const { root } = fixture();
  const r = onboardContext(root);
  assert.deepEqual(r.tour.steps.map(s => s.title), ['First', 'Second']);
  assert.deepEqual(r.tour.steps[0].nodes.map(n => n.filePath), ['f0.js']);
  assert.deepEqual(r.tour.steps[0].missingNodeIds, ['file:gone.js']);
  assert.equal(r.tour.omittedSteps, 0);
});

test('graph date, commit and freshness are reported; source drift makes it stale', () => {
  const { root, graph } = fixture();
  const clean = onboardContext(root);
  assert.equal(clean.freshness.status, 'current');
  assert.equal(clean.project.gitCommitHash, graph.project.gitCommitHash);
  assert.equal(clean.project.analyzedAt, '2026-11-01T00:00:00Z');
  writeFileSync(join(root, 'main.js'), 'export const main = 2;\n');
  const drift = onboardContext(root);
  assert.equal(drift.freshness.status, 'stale');
  assert.deepEqual(drift.freshness.changedFiles, ['main.js']);
});

test('non-codebase graphs and graphs without layers or tour still return a usable overview', () => {
  const { root } = fixture(g => ({ ...g, kind: 'knowledge', layers: undefined, tour: undefined }));
  const r = onboardContext(root);
  assert.equal(r.project.kind, 'knowledge');
  assert.deepEqual(r.layers, []);
  assert.deepEqual(r.tour.steps, []);
});

test('CLI validates the limit and reports a missing graph without a stack trace', () => {
  const { root } = fixture();
  const bad = spawnSync(process.execPath, [modulePath, root, '--limit', '0'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /limit must be an integer from 1 to 20/);
  const empty = join(temp, 'empty'); mkdirSync(empty);
  const missing = spawnSync(process.execPath, [modulePath, empty], { encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /^understand-onboard: Graph missing/);
  const ok = spawnSync(process.execPath, [modulePath, root, '--limit', '1'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).layers[0].keyNodes.length, 1);
});

test('CLI freshness paths are bounded with explicit totals while programmatic context stays complete', () => {
  const { root } = fixture();
  for (let i = 0; i < 650; i++) writeFileSync(join(root, `${String(i).padStart(4, '0')}-${'x'.repeat(230)}.js`), 'new\n');
  assert.equal(onboardContext(root).freshness.changedFiles.length, 650);
  const r = spawnSync(process.execPath, [modulePath, root, '--limit', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Buffer.byteLength(r.stdout, 'utf8') <= 131072, `stdout exceeds 128 KiB: ${Buffer.byteLength(r.stdout, 'utf8')} bytes`);
  const value = JSON.parse(r.stdout);
  assert.equal(value.freshness.changedFiles.length, 50); assert.equal(value.freshness.changedFileCount, 650);
  assert.equal(value.freshness.changedFilesTruncated, true);
});

test('CLI rejects oversized overview before stdout even when list limits are one', () => {
  const { root } = fixture(g => { g.project.description = 'я'.repeat(80000); return g; });
  const r = spawnSync(process.execPath, [modulePath, root, '--limit', '1'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, /128 KiB/);
  assert.match(r.stderr, /limits|query/); assert.match(r.stderr, /source files/);
});
