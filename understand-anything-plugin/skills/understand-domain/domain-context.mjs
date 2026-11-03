#!/usr/bin/env node
// Context preparation needs only Node's standard library, never the analysis runtime.
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const skillDir = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 64 * 1024;
const business = /controller|service|handler|router|route|endpoint|api|model|entity|repository|use.?case|command|event|workflow|payment|order|checkout|auth/i;
const supported = new Set(['file', 'module', 'endpoint', 'service', 'class', 'function', 'concept', 'table', 'schema']);
const clip = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const strings = (value, count = 8) => Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, count).map(v => clip(v, 80)) : [];
const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' , env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function sourceState(sourceRoot) {
  const status = git(sourceRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).ua', ':(exclude).understand-anything']);
  return {
    gitCommitHash: git(sourceRoot, ['rev-parse', '--verify', 'HEAD']) ?? '',
    workingTreeDirty: status === null || status.length > 0,
  };
}

export function resolveSource(path = '.') {
  const sourceRoot = realpathSync(resolve(path));
  if (!statSync(sourceRoot).isDirectory()) throw new Error('Project path must be a directory');
  const uaDir = join(sourceRoot, existsSync(join(sourceRoot, '.understand-anything')) ? '.understand-anything' : '.ua');
  if (existsSync(uaDir) && !statSync(uaDir).isDirectory()) throw new Error('Data path must be a directory');
  if (existsSync(uaDir) && realpathSync(uaDir) !== uaDir) throw new Error('Data directory must belong to the selected checkout, not a symlink');
  return { sourceRoot, uaDir, pluginRoot: realpathSync(resolve(skillDir, '../..')) };
}

function summarizeGraph(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !graph.project) throw new Error('Graph collections or project metadata are missing');
  const nodes = graph.nodes.filter(n => n && typeof n.id === 'string' && supported.has(n.type));
  const rank = n => (['endpoint', 'service'].includes(n.type) ? 8 : 0) + (business.test([n.id, n.name, n.filePath, ...(Array.isArray(n.tags) ? n.tags : [])].join(' ')) ? 4 : 0) + (['file', 'module', 'concept', 'table', 'schema'].includes(n.type) ? 2 : 0);
  nodes.sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
  const unique = new Map();
  for (const n of nodes) {
    if (unique.size >= 120) break;
    if (!unique.has(n.id)) unique.set(n.id, { id: n.id, type: n.type, name: clip(n.name, 160), summary: clip(n.summary), tags: strings(n.tags), ...(n.filePath ? { filePath: clip(n.filePath, 400) } : {}), ...(Array.isArray(n.lineRange) ? { lineRange: n.lineRange.slice(0, 2) } : {}) });
  }
  const context = {
    project: { name: clip(graph.project.name, 160), description: clip(graph.project.description, 1000), languages: strings(graph.project.languages, 20), frameworks: strings(graph.project.frameworks, 20) },
    nodes: [...unique.values()], edges: [],
    layers: (Array.isArray(graph.layers) ? graph.layers : []).slice(0, 12).map(l => ({ name: clip(l?.name, 120), description: clip(l?.description, 300) })),
    coverage: { totalNodes: graph.nodes.length, includedNodes: 0, omittedNodes: 0, totalEdges: graph.edges.length, includedEdges: 0, omittedEdges: 0 },
  };
  // Keep only relationships whose endpoints survived selection. No raw graph is sent.
  const ids = new Set(context.nodes.map(n => n.id));
  for (const e of graph.edges) {
    if (context.edges.length >= 240) break;
    if (e && ids.has(e.source) && ids.has(e.target) && ['calls', 'imports', 'contains', 'depends_on', 'routes', 'reads_from', 'writes_to'].includes(e.type)) context.edges.push({ source: e.source, target: e.target, type: e.type });
  }
  return context;
}

function updateCoverage(graph) {
  Object.assign(graph.coverage, { includedNodes: graph.nodes.length, omittedNodes: graph.coverage.totalNodes - graph.nodes.length, includedEdges: graph.edges.length, omittedEdges: graph.coverage.totalEdges - graph.edges.length });
}

export function prepareContext(args = []) {
  let path;
  let full = false;
  let positionalOnly = false;
  for (const arg of args) {
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && arg === '--full') { full = true; continue; }
    if (!positionalOnly && arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    if (path !== undefined) throw new Error('Supply only one project directory');
    path = arg;
  }
  const roots = resolveSource(path);
  const result = { ...roots, ...sourceState(roots.sourceRoot), mode: 'scan', warnings: [] };
  if (full) { result.warnings.push('Fresh lightweight scan requested; this is sampled context, not full architecture analysis.'); return result; }
  if (!existsSync(join(result.uaDir, 'knowledge-graph.json'))) return result;
  try {
    const graph = readJson(join(result.uaDir, 'knowledge-graph.json'));
    const meta = readJson(join(result.uaDir, 'meta.json'));
    const fingerprints = readJson(join(result.uaDir, 'fingerprints.json'));
    if (!meta || meta.sourceRoot !== result.sourceRoot) throw new Error('Graph source binding is missing or belongs to another checkout');
    if (!result.gitCommitHash || meta.gitCommitHash !== result.gitCommitHash || graph?.project?.gitCommitHash !== result.gitCommitHash || fingerprints?.gitCommitHash !== result.gitCommitHash) throw new Error('Graph baseline is missing, stale, or has disagreeing commit hashes');
    if (result.workingTreeDirty || meta.workingTreeDirty !== false) throw new Error('Current or previous source includes uncommitted changes');
    result.graphContext = summarizeGraph(graph);
    if (!result.graphContext.nodes.length) throw new Error('No relevant code nodes in graph');
    result.mode = 'graph';
    updateCoverage(result.graphContext);
    // Include the envelope in the byte cap; UTF-8 size matters for multilingual summaries.
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) {
      if (result.graphContext.edges.length) result.graphContext.edges.pop();
      else {
        const removed = result.graphContext.nodes.pop();
        if (!removed || !result.graphContext.nodes.length) throw new Error('Unable to fit graph context in byte budget');
      }
      updateCoverage(result.graphContext);
    }
  } catch (error) {
    result.mode = 'scan';
    delete result.graphContext;
    result.warnings.push(`${error.message}; using a fresh lightweight scan. Run /understand to regenerate a reusable codebase graph.`);
  }
  return result;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.slice(2).some(a => a === '--help' || a === '-h')) process.stdout.write('Usage: node domain-context.mjs [project-root] [--full]\n');
    else process.stdout.write(JSON.stringify(prepareContext(process.argv.slice(2))) + '\n');
  } catch (error) { process.stderr.write(`understand-domain: ${error.message}\n`); process.exitCode = 1; }
}
