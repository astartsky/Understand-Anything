#!/usr/bin/env node
// Read-only graph retrieval. No analysis runtime, dependencies, or Git index refresh.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node graph-context.mjs PROJECT_ROOT [--query TEXT] [--node ID ...] [--limit N] [--edge-offset N] [--edge-limit N]';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Invalid JSON or unreadable file: ${path}`); }
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, '-c', 'diff.autoRefreshIndex=false', ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.status === 0 ? result.stdout : null;
}

function sameRoot(recorded, root) {
  if (typeof recorded !== 'string' || !isAbsolute(recorded)) return false;
  try { return realpathSync(recorded) === root; }
  catch { return false; }
}

export function inspectGraph(projectRoot = '.') {
  const sourceRoot = realpathSync(resolve(projectRoot));
  if (!statSync(sourceRoot).isDirectory()) throw new Error(`Not a project directory: ${sourceRoot}`);
  const dataDir = join(sourceRoot, existsSync(join(sourceRoot, '.understand-anything')) ? '.understand-anything' : '.ua');
  const graphPath = join(dataDir, 'knowledge-graph.json');
  if (!existsSync(graphPath)) throw new Error(`Graph missing at ${graphPath}. Run /understand for this checkout first.`);
  const graph = readJson(graphPath);
  if (!graph?.project || typeof graph.project !== 'object'
    || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)
    || graph.nodes.some(node => !node || typeof node.id !== 'string')
    || graph.edges.some(edge => !edge || typeof edge.source !== 'string' || typeof edge.target !== 'string'
      || typeof edge.type !== 'string' || !['forward', 'backward', 'bidirectional'].includes(edge.direction))
    || (graph.layers !== undefined && (!Array.isArray(graph.layers)
      || graph.layers.some(layer => !layer || !Array.isArray(layer.nodeIds))))) {
    throw new Error(`Invalid graph structure at ${graphPath}. Run /understand to regenerate it.`);
  }
  const warnings = [];
  const warn = (code, message) => warnings.push({ code, message });
  let meta;
  if (existsSync(join(dataDir, 'meta.json'))) {
    try { meta = readJson(join(dataDir, 'meta.json')); }
    catch { warn('META_UNREADABLE', 'Analysis metadata is unreadable; its baseline cannot be verified.'); }
  }
  const matchingMeta = typeof graph.project.gitCommitHash === 'string' && Boolean(graph.project.gitCommitHash)
    && meta?.gitCommitHash === graph.project.gitCommitHash;
  const boundRoot = graph.project.sourceRoot ?? (matchingMeta ? meta?.sourceRoot : undefined);
  if (!boundRoot) warn('SOURCE_UNBOUND', 'Graph has no source checkout binding; it may have been copied.');
  else if (!sameRoot(boundRoot, sourceRoot)) warn('SOURCE_MISMATCH', 'Graph belongs to a different or unavailable source checkout.');
  if (meta && (!matchingMeta || (meta.sourceRoot && !sameRoot(meta.sourceRoot, sourceRoot)))) {
    warn('META_MISMATCH', 'Graph and analysis metadata disagree on commit or source checkout.');
  }
  const baselineDirty = graph.project.workingTreeDirty ?? (matchingMeta ? meta?.workingTreeDirty : undefined);
  if (baselineDirty === true || (matchingMeta && meta?.workingTreeDirty === true)) {
    warn('BASELINE_DIRTY', 'Graph was built with uncommitted files; its commit does not describe the analyzed contents.');
  } else if (baselineDirty !== false) {
    warn('BASELINE_DIRTY_UNKNOWN', 'Graph does not record whether the analyzed working tree was clean.');
  }

  const rawCommit = graph.project.gitCommitHash;
  const currentCommit = git(sourceRoot, ['rev-parse', '--verify', 'HEAD'])?.trim() || null;
  let graphCommit = null;
  const changedFiles = new Set();
  if (!currentCommit) {
    warn('GIT_UNAVAILABLE', 'Current Git HEAD is unavailable; source freshness is unverified.');
  } else {
    if (typeof rawCommit === 'string' && /^[a-f0-9]{7,64}$/i.test(rawCommit)) {
      graphCommit = git(sourceRoot, ['rev-parse', '--verify', '--end-of-options', `${rawCommit}^{commit}`])?.trim() || null;
    }
    if (!graphCommit) warn('GRAPH_COMMIT_INVALID', 'Graph commit is missing, invalid, or unavailable in this checkout.');
    // Git paths are relative to the selected project; sibling monorepo commits are irrelevant.
    const scope = ['--', '.', ':(exclude).ua', ':(exclude).understand-anything'];
    const queries = [
      // --name-only trusts changed stat data when index refresh is disabled; numstat compares contents.
      ['WORKTREE_CHANGED', ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', '--relative', ...scope]],
      ['WORKTREE_CHANGED', ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', '--relative', ...scope]],
      ['WORKTREE_CHANGED', ['ls-files', '--others', '--exclude-standard', '-z', ...scope]],
    ];
    if (graphCommit) queries.unshift(['COMMITTED_CHANGED', ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', '--relative', graphCommit, 'HEAD', ...scope]]);
    const changedKinds = new Set();
    for (const [code, args] of queries) {
      const output = git(sourceRoot, args);
      if (output === null) { warn('GIT_CHECK_FAILED', 'A project-scoped Git diff/file check failed; freshness is unverified.'); continue; }
      const records = output.split('\0').filter(Boolean);
      const paths = args.includes('--numstat')
        ? records.map(record => record.slice(record.indexOf('\t', record.indexOf('\t') + 1) + 1))
        : records;
      if (paths.length) changedKinds.add(code);
      paths.forEach(path => changedFiles.add(path));
    }
    if (changedKinds.has('COMMITTED_CHANGED')) warn('COMMITTED_CHANGED', 'Committed project files differ from the graph baseline.');
    if (changedKinds.has('WORKTREE_CHANGED')) warn('WORKTREE_CHANGED', 'Staged, unstaged, or untracked project files may be absent from the graph.');
  }
  const staleCodes = new Set(['SOURCE_MISMATCH', 'META_MISMATCH', 'BASELINE_DIRTY', 'COMMITTED_CHANGED', 'WORKTREE_CHANGED']);
  const status = warnings.some(w => staleCodes.has(w.code)) ? 'stale' : warnings.length ? 'unverified' : 'current';
  return { sourceRoot, dataDir, graph, freshness: { status, graphCommit, currentCommit, changedFiles: [...changedFiles].sort(), warnings } };
}

function integer(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function selectContext(graph, { query = '', nodeIds = [], limit = 20, edgeOffset = 0, edgeLimit = 100 } = {}) {
  integer(limit, 'limit', 1, 100);
  integer(edgeOffset, 'edgeOffset', 0);
  integer(edgeLimit, 'edgeLimit', 1, 500);
  if (typeof query !== 'string' || !Array.isArray(nodeIds) || nodeIds.some(id => typeof id !== 'string')) throw new Error('query must be text and nodeIds must be an array of IDs');
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (const id of nodeIds) if (!byId.has(id)) throw new Error(`Unknown node ID: ${id}`);
  const wanted = new Set(nodeIds);
  const needle = query.trim().toLowerCase();
  const matches = graph.nodes.filter(node => wanted.has(node.id) || (needle && [node.id, node.name, node.filePath, node.summary, ...(node.tags ?? [])].join(' ').toLowerCase().includes(needle)));
  const matchedNodes = matches.slice(0, limit);
  const selectedIds = new Set(matchedNodes.map(node => node.id));
  const allEdges = graph.edges.filter(edge => selectedIds.has(edge.source) || selectedIds.has(edge.target));
  const edges = allEdges.slice(edgeOffset, edgeOffset + edgeLimit);
  const endpointIds = new Set(edges.flatMap(edge => [edge.source, edge.target]));
  const neighborNodes = [...endpointIds].filter(id => !selectedIds.has(id)).map(id => byId.get(id)).filter(Boolean);
  const missingNodeIds = [...endpointIds].filter(id => !byId.has(id));
  const contextIds = new Set([...selectedIds, ...endpointIds]);
  const layers = (graph.layers ?? []).filter(layer => layer.nodeIds.some(id => contextIds.has(id))).map(layer => ({
    ...layer, totalNodeCount: layer.nodeIds.length, nodeIds: layer.nodeIds.filter(id => contextIds.has(id)),
  }));
  return { matchedNodes, neighborNodes, missingNodeIds, edges, layers,
    counts: { matchedNodes: matches.length, selectedNodes: matchedNodes.length, totalEdges: allEdges.length, returnedEdges: edges.length },
    pagination: { limit, edgeOffset, edgeLimit, nextEdgeOffset: edgeOffset + edges.length < allEdges.length ? edgeOffset + edges.length : null },
  };
}

// Bound CLI output without pruning graph fields or altering programmatic contexts.
export function serializeContext(context) {
  const freshness = context.freshness;
  const output = Array.isArray(freshness?.changedFiles) ? {
    ...context,
    freshness: {
      ...freshness,
      changedFiles: freshness.changedFiles.slice(0, 50),
      changedFileCount: freshness.changedFiles.length,
      changedFilesTruncated: freshness.changedFiles.length > 50,
    },
  } : context;
  const serialized = JSON.stringify(output, null, 2);
  // Include the newline emitted by both CLIs in the hard UTF-8 byte budget.
  if (Buffer.byteLength(serialized, 'utf8') + 1 > 128 * 1024) {
    throw new Error('Context exceeds the 128 KiB output budget. Reduce limits, narrow the query, or read relevant source files.');
  }
  return serialized;
}

function run(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return usage;
  const projectRoot = args.shift();
  if (!projectRoot || projectRoot.startsWith('--')) throw new Error(usage);
  const options = { nodeIds: [] };
  const names = { '--query': 'query', '--limit': 'limit', '--edge-offset': 'edgeOffset', '--edge-limit': 'edgeLimit' };
  while (args.length) {
    const flag = args.shift();
    if (!(flag in names) && flag !== '--node') throw new Error(`Unknown option: ${flag}\n${usage}`);
    if (!args.length) throw new Error(`Missing value for ${flag}`);
    const value = args.shift();
    if (flag === '--node') options.nodeIds.push(value);
    else options[names[flag]] = flag === '--query' ? value : Number(value);
  }
  const { graph, ...context } = inspectGraph(projectRoot);
  return serializeContext({ ...context, project: graph.project, ...selectContext(graph, options) });
}

const isCli = process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isCli) {
  try { process.stdout.write(run(process.argv.slice(2)) + '\n'); }
  catch (error) { process.stderr.write(`understand-chat: ${error.message}\n`); process.exitCode = 1; }
}
