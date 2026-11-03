#!/usr/bin/env node
// Read-only Git/graph impact collection; no plugin build or third-party packages.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node diff-context.mjs [project-path] [--base <ref>] [--head <ref> --committed-only]\n       node diff-context.mjs --write-overlay <context.json>';
const scope = ['--', '.', ':(exclude).ua', ':(exclude).understand-anything'];
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-renames', '--relative'];
const sorted = values => [...new Set(values)].sort();
const sha256 = data => createHash('sha256').update(data).digest('hex');
function git(root, args, optional = false) {
  const result = spawnSync('git', ['-c', 'diff.autoRefreshIndex=false', '-C', root, ...args], {maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (result.status !== 0) {
    if (optional) return null;
    throw new Error(`Git ${args[0]} failed: ${result.error?.message ?? result.stderr?.toString().trim() ?? 'unknown error'}`);
  }
  return result.stdout;
}
function commit(root, ref, optional = false) {
  const result = git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], true);
  if (!result && !optional) throw new Error(`Cannot resolve comparison commit: ${ref}`);
  return result?.toString().trim() ?? null;
}
function paths(root, args) {
  const records = git(root, args).toString('utf8').split('\0').filter(Boolean);
  return sorted(args.includes('--numstat')
    ? records.map(record => record.slice(record.indexOf('\t', record.indexOf('\t') + 1) + 1))
    : records);
}
function json(path, optional = false) {
  if (optional && !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`Cannot read JSON ${path}: ${error.message}`); }
}

export function collectContext({sourceRoot = '.', baseRef, headRef, committedOnly = false} = {}) {
  sourceRoot = realpathSync(resolve(sourceRoot));
  if (headRef && !committedOnly) throw new Error('--head requires --committed-only; local changes belong to the checked-out HEAD');
  if (committedOnly && !baseRef) throw new Error('--committed-only requires an explicit --base');
  const headCommitHash = commit(sourceRoot, headRef ?? 'HEAD');
  const baseRefCommitHash = commit(sourceRoot, baseRef ?? 'HEAD');
  const baseCommitHash = baseRef
    ? git(sourceRoot, ['merge-base', baseRefCommitHash, headCommitHash]).toString().trim()
    : headCommitHash;
  const uaDir = join(sourceRoot, existsSync(join(sourceRoot, '.understand-anything')) ? '.understand-anything' : '.ua');
  const graphPath = join(uaDir, 'knowledge-graph.json');
  const graphBytes = readFileSync(graphPath);
  let graph;
  try { graph = JSON.parse(graphBytes.toString('utf8')); }
  catch (error) { throw new Error(`Cannot read JSON ${graphPath}: ${error.message}`); }
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Graph must contain nodes and edges arrays');
  const meta = json(join(uaDir, 'meta.json'), true);
  // With index refresh disabled, --name-only can mistake stat-only changes for edits.
  const diffPaths = (...args) => paths(sourceRoot, ['diff', ...diffOptions, args.length ? '--name-only' : '--numstat', '-z', ...args, ...scope]);
  const changeSources = {
    committed: diffPaths(baseCommitHash, headCommitHash),
    staged: committedOnly ? [] : diffPaths('--cached', headCommitHash),
    unstaged: committedOnly ? [] : diffPaths(),
    untracked: committedOnly ? [] : paths(sourceRoot, ['ls-files', '--others', '--exclude-standard', '-z', ...scope]),
  };
  const changedFiles = sorted(Object.values(changeSources).flat());
  const patchHash = createHash('sha256');
  const addPatch = (label, ...args) => {
    const bytes = git(sourceRoot, ['diff', ...diffOptions, '--binary', ...args, ...scope]);
    patchHash.update(JSON.stringify([label, bytes.length])).update(bytes);
  };
  const warnings = [];
  const untrackedBoundaries = [];
  addPatch('committed', baseCommitHash, headCommitHash);
  if (!committedOnly) {
    addPatch('staged', '--cached', headCommitHash);
    addPatch('unstaged');
    for (const path of changeSources.untracked) {
      const absolute = join(sourceRoot, path);
      let stat = lstatSync(absolute);
      let bytes;
      if (stat.isSymbolicLink()) bytes = Buffer.from(readlinkSync(absolute));
      else if (stat.isFile()) {
        // Recheck the opened descriptor: a writer can replace the path after lstat.
        // Nonblocking, no-follow open prevents waiting on a replacement FIFO.
        const fd = openSync(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          stat = fstatSync(fd);
          if (stat.isFile()) bytes = readFileSync(fd);
        } finally { closeSync(fd); }
      }
      if (bytes !== undefined) {
        patchHash.update(JSON.stringify([path, stat.mode, bytes.length])).update(bytes);
      } else {
        // Git emits nested repositories/worktrees as directories. Do not traverse them
        // or open special files (opening a FIFO for reading could block indefinitely).
        const type = stat.isDirectory() ? 'directory' : stat.isFIFO() ? 'fifo'
          : stat.isSocket() ? 'socket' : stat.isCharacterDevice() ? 'character-device'
          : stat.isBlockDevice() ? 'block-device' : 'special';
        patchHash.update(JSON.stringify([path, stat.mode, type]));
        untrackedBoundaries.push({path, type});
        warnings.push(`Untracked ${type} ${JSON.stringify(path)} is an opaque boundary: only path/type/mode are fingerprinted; its contents and nested Git state are not fingerprinted. Analyze it separately.`);
      }
    }
  }
  const workingTreeHash = patchHash.digest('hex');
  const graphSourceRoot = graph.project?.sourceRoot ?? meta?.sourceRoot;
  if (!graphSourceRoot || graphSourceRoot !== sourceRoot) warnings.push('Graph source root is missing or differs from the selected checkout; refresh with /understand.');
  const graphCommitHash = graph.project?.gitCommitHash ?? null;
  const graphCommitResolvedHash = typeof graphCommitHash === 'string' && graphCommitHash ? commit(sourceRoot, graphCommitHash, true) : null;
  if (!graphCommitResolvedHash) warnings.push('Graph commit is missing or cannot be resolved; freshness is unknown.');
  if ((graph.project?.workingTreeDirty ?? meta?.workingTreeDirty) !== false) warnings.push('Graph baseline is dirty or its uncommitted state is unknown; refresh with /understand.');
  if (meta?.gitCommitHash && graphCommitHash !== meta.gitCommitHash) warnings.push('Graph and metadata commit hashes disagree; refresh with /understand.');
  const graphDrift = {
    committed: graphCommitResolvedHash ? diffPaths(graphCommitResolvedHash, headCommitHash) : null,
    staged: changeSources.staged,
    unstaged: changeSources.unstaged,
    untracked: changeSources.untracked,
  };
  if (Object.values(graphDrift).some(files => files?.length)) warnings.push('Graph may omit changed source files; inspect the actual diff and refresh with /understand when needed.');
  const changedSet = new Set(changedFiles);
  const normalize = path => typeof path === 'string' ? path.replace(/^\.\//, '') : null;
  const changedNodes = graph.nodes.filter(node => changedSet.has(normalize(node.filePath)));
  const changedIds = new Set(changedNodes.map(node => node.id));
  const edges = graph.edges.filter(edge => changedIds.has(edge.source) || changedIds.has(edge.target));
  const affectedIds = new Set(edges.flatMap(edge => [edge.source, edge.target]).filter(id => !changedIds.has(id)));
  const affectedNodes = graph.nodes.filter(node => affectedIds.has(node.id));
  const relevantIds = new Set([...changedIds, ...affectedIds]);
  const mappedFiles = new Set(changedNodes.map(node => normalize(node.filePath)));
  return {
    version:'1.0.0', sourceRoot, uaDir,
    request:{sourceRoot, baseRef, headRef, committedOnly},
    comparisonMode: committedOnly ? 'committed-only' : baseRef ? 'branch-and-working-tree' : 'working-tree',
    baseBranch:baseRef ?? 'HEAD', baseRefCommitHash, baseCommitHash, headCommitHash,
    graphCommitHash, graphCommitResolvedHash, graphContentHash:sha256(graphBytes), workingTreeHash,
    changeSources, changedFiles, changedNodeIds:sorted(changedIds), affectedNodeIds:sorted(affectedNodes.map(node => node.id)),
    unmappedFiles:changedFiles.filter(path => !mappedFiles.has(path)),
    graphDrift, warnings, untrackedBoundaries, changedNodes, affectedNodes, edges,
    affectedLayers:(graph.layers ?? []).filter(layer => layer.nodeIds?.some(id => relevantIds.has(id))),
  };
}

export function writeOverlay(context) {
  const current = collectContext(context.request);
  const identity = value => JSON.stringify([
    value.sourceRoot, value.uaDir, value.comparisonMode, value.baseRefCommitHash, value.baseCommitHash,
    value.headCommitHash, value.graphCommitHash, value.graphContentHash, value.workingTreeHash,
  ]);
  if (identity(current) !== identity(context)) throw new Error('Diff or graph inputs changed during analysis; collect context and review again before writing the overlay');
  const { request: _request, changedNodes: _changedNodes, affectedNodes: _affectedNodes, edges: _edges, affectedLayers: _affectedLayers, ...overlay } = current;
  const path = join(current.uaDir, 'diff-overlay.json');
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({...overlay, generatedAt:new Date().toISOString()}, null, 2) + '\n', {flag:'wx'});
  renameSync(temporary, path);
  return path;
}

function parseArgs(args) {
  const options = {};
  for (let i=0; i<args.length; i++) {
    const arg=args[i];
    if (arg==='--committed-only') options.committedOnly=true;
    else if (arg==='--base' || arg==='--head') {
      const value=args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a ref`);
      options[arg==='--base' ? 'baseRef' : 'headRef']=value;
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (options.sourceRoot) throw new Error('Supply only one project directory');
    else options.sourceRoot=arg;
  }
  return options;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args=process.argv.slice(2);
    if (args.length===1 && ['--help','-h'].includes(args[0])) console.log(usage);
    else if (args[0]==='--write-overlay' && args.length===2) console.log(writeOverlay(json(args[1])));
    else console.log(JSON.stringify(collectContext(parseArgs(args)), null, 2));
  } catch (error) {
    console.error(`understand-diff: ${error.message}`);
    process.exitCode=1;
  }
}
