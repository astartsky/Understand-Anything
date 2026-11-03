import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync,
  existsSync, realpathSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const skill = process.env.DOMAIN_SKILL_DIR || dirname(fileURLToPath(import.meta.url));
const { prepareContext } = await import(pathToFileURL(join(skill, 'domain-context.mjs')));
const { publishDomain } = await import(pathToFileURL(join(skill, 'validate-domain.mjs')));

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function put(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data));
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'domain-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  put(join(root, '.gitignore'), '.ua/\n.understand-anything/\n');
  put(join(root, 'orders.ts'), "app.post('/orders',createOrder);\n");
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

function node(id, type = 'file', summary = 'Business orders') {
  return { id, type, name: id, summary, tags: ['orders'], complexity: 'simple' };
}

function bind(root, graph) {
  const sha = git(root, 'rev-parse', 'HEAD');
  put(join(root, '.ua', 'knowledge-graph.json'), {
    version: '1.0.0',
    project: {
      name: 'Orders', languages: ['TypeScript'], frameworks: [],
      description: 'Orders', analyzedAt: '2026-11-03T00:00:00Z', gitCommitHash: sha,
    },
    layers: [], tour: [], ...graph,
  });
  put(join(root, '.ua', 'meta.json'), {
    sourceRoot: root, gitCommitHash: sha, workingTreeDirty: false,
  });
  put(join(root, '.ua', 'fingerprints.json'), { gitCommitHash: sha });
}

function domain(context) {
  return {
    version: '1.0.0',
    project: {
      name: 'Orders', languages: ['TypeScript'], frameworks: [],
      description: 'Order checkout', analyzedAt: '2026-11-03T00:00:00Z',
      gitCommitHash: context.gitCommitHash,
    },
    nodes: [
      node('domain:orders', 'domain'), node('flow:create-order', 'flow'),
      { ...node('step:create-order:save', 'step'), filePath: 'orders.ts', lineRange: [1, 1] },
    ],
    edges: [
      { source: 'domain:orders', target: 'flow:create-order', type: 'contains_flow', direction: 'forward', weight: 1 },
      { source: 'flow:create-order', target: 'step:create-order:save', type: 'flow_step', direction: 'forward', weight: 1 },
    ],
    layers: [], tour: [],
  };
}

test('large graph becomes bounded relevant context with honest omissions', t => {
  const root = fixture(t);
  const nodes = Array.from({ length: 8000 }, (_, i) =>
    node(`file:util-${i}.ts`, 'file', 'Utility '.repeat(120)));
  const longId = 'file:service-' + 'x'.repeat(420);
  nodes.push(node(longId));
  nodes.push({
    ...node('file:controllers/checkout.ts', 'endpoint', 'Создаёт заказ'),
    filePath: 'controllers/checkout.ts',
  });
  const edges = nodes.slice(0, -1).map(n => ({
    source: 'file:controllers/checkout.ts', target: n.id,
    type: 'calls', direction: 'forward', weight: 1,
  }));
  bind(root, { nodes, edges });
  assert.ok(readFileSync(join(root, '.ua', 'knowledge-graph.json')).length > 5 * 1024 * 1024);
  const result = prepareContext([root]);
  assert.equal(result.mode, 'graph');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  assert.ok(result.graphContext.nodes.some(n => n.id === 'file:controllers/checkout.ts'));
  assert.ok(result.graphContext.coverage.omittedNodes > 0);
  assert.ok(result.graphContext.nodes.some(n => n.id === longId));
  const ids = new Set(result.graphContext.nodes.map(n => n.id));
  assert.ok(result.graphContext.edges.every(e => ids.has(e.source) && ids.has(e.target)));
});

test('graph reuse refuses copied, dirty, stale or malformed baselines', t => {
  const root = fixture(t);
  bind(root, { nodes: [node('file:orders.ts')], edges: [] });
  assert.equal(prepareContext([root]).mode, 'graph');
  put(join(root, '.ua', 'meta.json'), {
    sourceRoot: '/different-checkout', gitCommitHash: git(root, 'rev-parse', 'HEAD'),
    workingTreeDirty: false,
  });
  assert.equal(prepareContext([root]).mode, 'scan');
  bind(root, { nodes: [node('file:orders.ts')], edges: [] });
  put(join(root, 'new.ts'), 'export const pending=1;');
  assert.equal(prepareContext([root]).mode, 'scan');
  rmSync(join(root, 'new.ts'));
  git(root, 'commit', '--allow-empty', '-qm', 'moved');
  assert.equal(prepareContext([root]).mode, 'scan');
  put(join(root, '.ua', 'knowledge-graph.json'), '{');
  assert.equal(prepareContext([root]).mode, 'scan');
  assert.equal(prepareContext([root, '--full']).mode, 'scan');
  assert.throws(() => prepareContext([root, '--unknown']));
});

test('worktree scanner uses selected source and output while main graph stays unchanged', t => {
  const main = fixture(t);
  const checkout = `${main}-feature`;
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  git(main, 'worktree', 'add', '-qb', 'feature', checkout);
  put(join(checkout, 'feature-only.ts'), "app.get('/feature',handleFeature);\n");
  put(join(main, '.ua', 'domain-graph.json'), 'MAIN SENTINEL');
  const context = prepareContext([checkout]);
  assert.equal(context.sourceRoot, checkout);
  assert.equal(context.uaDir, join(checkout, '.ua'));
  const run = spawnSync('python3', [join(skill, 'extract-domain-context.py'), context.sourceRoot], {
    cwd: checkout, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const scan = JSON.parse(readFileSync(join(checkout, '.ua', 'intermediate', 'domain-context.json')));
  assert.ok(scan.fileTree.includes('feature-only.ts'));
  assert.equal(readFileSync(join(main, '.ua', 'domain-graph.json'), 'utf8'), 'MAIN SENTINEL');
  assert.ok(!existsSync(join(main, '.ua', 'intermediate', 'domain-context.json')));
});

test('domain save validates schema and hierarchy, refuses loss and preserves last valid graph', async t => {
  const root = fixture(t);
  const context = prepareContext([root]);
  const output = join(root, '.ua', 'domain-graph.json');
  const input = join(root, '.ua', 'intermediate', 'domain-analysis.json');
  const valid = domain(context);
  put(input, valid);
  await publishDomain(input, context);
  assert.equal(JSON.parse(readFileSync(output)).nodes.length, 3);
  const before = readFileSync(output, 'utf8');
  const defects = [
    g => g.nodes.push(g.nodes[0]),
    g => g.edges.shift(),
    g => { g.nodes[0].type = 'file'; },
    g => g.nodes.push(node('step:create-order:ship', 'step')),
    g => g.nodes.push(node('invalid', 'NOT_A_TYPE')),
    g => { g.nodes[2].filePath = '../escape.ts'; },
    g => { g.nodes[2].filePath = '.'; },
    g => { g.edges[1].target = 'missing'; },
    g => { g.project = null; },
    g => {
      g.nodes.push(node('step:create-order:ship', 'step'));
      g.edges.push({ ...g.edges[1], target: 'step:create-order:ship' });
    },
  ];
  for (const mutate of defects) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    put(input, candidate);
    await assert.rejects(() => publishDomain(input, context));
    assert.equal(readFileSync(output, 'utf8'), before);
  }
});

test('source movement blocks publication and dirty/non-Git snapshots are labeled', async t => {
  const root = fixture(t);
  const context = prepareContext([root]);
  const input = join(root, '.ua', 'intermediate', 'domain-analysis.json');
  put(input, domain(context));
  put(join(root, '.ua', 'domain-graph.json'), 'PREVIOUS');
  git(root, 'commit', '--allow-empty', '-qm', 'move');
  await assert.rejects(() => publishDomain(input, context), /HEAD/);
  assert.equal(readFileSync(join(root, '.ua', 'domain-graph.json'), 'utf8'), 'PREVIOUS');
  put(join(root, 'pending.ts'), 'export const pending=1;');
  const dirty = prepareContext([root]);
  put(input, domain(dirty));
  await publishDomain(input, dirty);
  assert.equal(JSON.parse(readFileSync(join(root, '.ua', 'domain-graph.json'))).analysisContext.workingTreeDirty, true);
  const nongit = mkdtempSync(join(tmpdir(), 'domain-nongit-'));
  t.after(() => rmSync(nongit, { recursive: true, force: true }));
  assert.equal(prepareContext([nongit]).workingTreeDirty, true);
});

test('CLI saves consumable domain-only output and respects legacy data directories', t => {
  const root = fixture(t);
  mkdirSync(join(root, '.understand-anything'));
  const result = spawnSync(process.execPath, [join(skill, 'domain-context.mjs'), root, '--full'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout);
  assert.equal(context.uaDir, join(root, '.understand-anything'));
  const input = join(context.uaDir, 'intermediate', 'domain-analysis.json');
  const preflight = join(context.uaDir, 'intermediate', 'domain-source.json');
  put(input, domain(context));
  put(preflight, context);
  const save = spawnSync(process.execPath, [join(skill, 'validate-domain.mjs'), input, preflight], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(save.status, 0, save.stderr);
  assert.equal(JSON.parse(save.stdout).nodes, 3);
  assert.ok(!existsSync(join(context.uaDir, 'knowledge-graph.json')));
  const consume = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {loadDomainGraph} from ${JSON.stringify(pathToFileURL(join(context.pluginRoot, 'packages/core/dist/index.js')).href)};\n` +
    `const g=loadDomainGraph(process.argv[1]); if(g.nodes.length!==3 || g.project.sourceRoot!==process.argv[1])process.exit(1);`, root],
    { encoding: 'utf8' });
  assert.equal(consume.status, 0, consume.stderr);
});

test('graph context preparation works without a built plugin runtime', t => {
  const root = fixture(t);
  bind(root, { nodes: [node('file:orders.ts')], edges: [] });
  const runtime = realpathSync(mkdtempSync(join(tmpdir(), 'domain-unbuilt-')));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const helper = join(runtime, 'skills', 'understand-domain', 'domain-context.mjs');
  mkdirSync(dirname(helper), { recursive: true });
  copyFileSync(join(skill, 'domain-context.mjs'), helper);
  const preflight = spawnSync(process.execPath, [helper, root], { encoding: 'utf8' });
  assert.equal(preflight.status, 0, preflight.stderr);
  const context = JSON.parse(preflight.stdout);
  assert.equal(context.mode, 'graph');
  assert.equal(context.pluginRoot, runtime);
  assert.ok(!existsSync(join(runtime, 'packages')));
  assert.ok(!existsSync(join(root, '.ua', 'intermediate')));
});
