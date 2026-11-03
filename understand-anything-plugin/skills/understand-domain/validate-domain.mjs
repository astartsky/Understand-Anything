#!/usr/bin/env node
// The real core validator normalizes schema fields; domain topology is checked here.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSource, sourceState } from './domain-context.mjs';

function checkHierarchy(graph, sourceRoot) {
  const ids = new Map();
  for (const n of graph.nodes) {
    if (!['domain', 'flow', 'step'].includes(n.type)) throw new Error(`Non-domain node: ${n.id}`);
    if (ids.has(n.id)) throw new Error(`Duplicate node ID: ${n.id}`);
    if (!new RegExp(`^${n.type}:[a-z0-9]+(?:[-:][a-z0-9]+)*$`).test(n.id)) throw new Error(`Invalid domain node ID: ${n.id}`);
    if (!n.name.trim() || !n.summary.trim() || !n.tags.some(tag => tag.trim())) throw new Error(`Empty name, summary, or tags: ${n.id}`);
    if (n.filePath !== undefined) {
      if (isAbsolute(n.filePath)) throw new Error(`Source file must be relative: ${n.id}`);
      const absolute = realpathSync(join(sourceRoot, n.filePath));
      if (!statSync(absolute).isFile()) throw new Error(`Source anchor must be a file: ${n.id}`);
      const path = relative(sourceRoot, absolute);
      if (path === '..' || path.startsWith('../') || isAbsolute(path)) throw new Error(`Source file escapes checkout: ${n.id}`);
    }
    ids.set(n.id, n.type);
  }
  if (graph.layers.length || graph.tour.length) throw new Error('Domain graphs require empty layers and tour');
  const parents = new Map();
  const weights = new Map();
  const seen = new Set();
  for (const e of graph.edges) {
    const types = { contains_flow: ['domain', 'flow'], flow_step: ['flow', 'step'], cross_domain: ['domain', 'domain'] }[e.type];
    if (!types || ids.get(e.source) !== types[0] || ids.get(e.target) !== types[1] || e.source === e.target) throw new Error(`Invalid domain edge: ${e.source} ${e.type} ${e.target}`);
    const key = JSON.stringify([e.source, e.type, e.target]);
    if (seen.has(key)) throw new Error(`Duplicate edge: ${key}`);
    seen.add(key);
    if (e.type !== 'cross_domain') {
      if (e.direction !== 'forward') throw new Error(`Hierarchy edge must point forward: ${key}`);
      parents.set(e.target, (parents.get(e.target) ?? 0) + 1);
    }
    if (e.type === 'flow_step') {
      const used = weights.get(e.source) ?? new Set();
      if (used.has(e.weight)) throw new Error(`Ambiguous step order in ${e.source}`);
      used.add(e.weight);
      weights.set(e.source, used);
    }
  }
  for (const n of graph.nodes) if (n.type !== 'domain' && parents.get(n.id) !== 1) throw new Error(`Expected one parent for ${n.id}`);
}

export async function publishDomain(inputPath, context) {
  const roots = resolveSource(context.sourceRoot);
  if (roots.sourceRoot !== context.sourceRoot || roots.uaDir !== context.uaDir || roots.pluginRoot !== context.pluginRoot) throw new Error('Source/data/runtime binding changed');
  if (!['scan', 'graph'].includes(context.mode) || typeof context.workingTreeDirty !== 'boolean' || !Array.isArray(context.warnings)) throw new Error('Invalid analysis context');
  const current = sourceState(roots.sourceRoot);
  if (current.gitCommitHash !== context.gitCommitHash) throw new Error('Source HEAD changed; domain graph not saved');
  let validateGraph;
  try { ({ validateGraph } = await import(pathToFileURL(join(roots.pluginRoot, 'packages/core/dist/index.js')))); }
  catch (error) { throw new Error(`Core validator cannot load: ${error.message}. Prepare the pinned plugin runtime under host policy; no install/build was run.`); }
  const candidate = JSON.parse(readFileSync(inputPath, 'utf8'));
  const validation = validateGraph(candidate);
  if (!validation.success) throw new Error(`Invalid graph: ${validation.fatal ?? JSON.stringify(validation.errors)}`);
  if (validation.issues.some(issue => issue.level === 'dropped')) throw new Error(`Validation would discard data: ${JSON.stringify(validation.issues)}`);
  const graph = validation.data;
  if (graph.project.gitCommitHash !== context.gitCommitHash) throw new Error('Candidate commit differs from source context');
  checkHierarchy(graph, roots.sourceRoot);
  const finalState = sourceState(roots.sourceRoot);
  if (finalState.gitCommitHash !== context.gitCommitHash) throw new Error('Source HEAD changed; domain graph not saved');
  graph.project.sourceRoot = roots.sourceRoot;
  graph.project.workingTreeDirty = context.workingTreeDirty || finalState.workingTreeDirty;
  graph.analysisContext = { sourceRoot: roots.sourceRoot, gitCommitHash: context.gitCommitHash, workingTreeDirty: context.workingTreeDirty || finalState.workingTreeDirty, mode: context.mode, warnings: context.warnings, ...(context.graphContext ? { coverage: context.graphContext.coverage } : {}) };
  mkdirSync(roots.uaDir, { recursive: true });
  const output = join(roots.uaDir, 'domain-graph.json');
  const temp = `${output}.${process.pid}.tmp`;
  try { writeFileSync(temp, JSON.stringify(graph, null, 2) + '\n', { flag: 'wx' }); renameSync(temp, output); }
  finally { rmSync(temp, { force: true }); }
  return { output, issues: validation.issues, nodes: graph.nodes.length, edges: graph.edges.length, analysisContext: graph.analysisContext };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) process.stdout.write('Usage: node validate-domain.mjs <domain-analysis.json> <domain-source.json>\n');
    else {
      if (args.length !== 2) throw new Error('Expected domain-analysis.json and domain-source.json');
      process.stdout.write(JSON.stringify(await publishDomain(args[0], JSON.parse(readFileSync(args[1], 'utf8'))), null, 2) + '\n');
    }
  } catch (error) { process.stderr.write(`understand-domain: ${error.message}\n`); process.exitCode = 1; }
}
