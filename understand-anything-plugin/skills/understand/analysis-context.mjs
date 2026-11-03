#!/usr/bin/env node
// Resolve the analyzed checkout without changing it to the Git common directory.
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { existsSync, realpathSync, statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const skillDir = dirname(fileURLToPath(import.meta.url));
const usage = 'Usage: node analysis-context.mjs context [path] [--full|--review|--auto-update|--no-auto-update] [--language <lang>] [--exclude <patterns>]\n       node analysis-context.mjs save-meta <context.json>';
const booleanFlags = new Set(['--full', '--review', '--auto-update', '--no-auto-update']);
const valueFlags = new Set(['--language', '--exclude']);

export function parseArguments(args, cwd = process.cwd()) {
  const options = {};
  let path;
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && booleanFlags.has(arg)) { options[arg.slice(2)] = true; continue; }
    if (!positionalOnly && valueFlags.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
      continue;
    }
    if (!positionalOnly && arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    if (path !== undefined) throw new Error('Supply only one project directory');
    path = arg;
  }
  if (options['auto-update'] && options['no-auto-update']) throw new Error('--auto-update and --no-auto-update conflict');
  const sourceRoot = realpathSync(resolve(cwd, path ?? '.'));
  if (!statSync(sourceRoot).isDirectory()) throw new Error(`Project path is not a directory: ${sourceRoot}`);
  const uaDir = join(sourceRoot, existsSync(join(sourceRoot, '.understand-anything')) ? '.understand-anything' : '.ua');
  if (existsSync(uaDir) && !statSync(uaDir).isDirectory()) throw new Error(`Data path is not a directory: ${uaDir}`);
  return { sourceRoot, uaDir, options };
}

function git(sourceRoot, args) {
  const result = spawnSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' , env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sourceState(sourceRoot) {
  const gitCommitHash = git(sourceRoot, ['rev-parse', '--verify', 'HEAD']) ?? '';
  const gitBranch = git(sourceRoot, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const status = git(sourceRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).ua', ':(exclude).understand-anything']);
  return { gitCommitHash, gitBranch, workingTreeDirty: status === null || status.length > 0 };
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Invalid JSON: ${path}`); }
}

export async function checkRuntime(pluginRoot = resolve(skillDir, '../..')) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Understand requires Node.js >= 22; no runtime was installed or changed.');
  pluginRoot = resolve(pluginRoot);
  const required = ['package.json', 'packages/core/dist/index.js', 'agents/project-scanner.md', 'agents/file-analyzer.md', 'agents/assemble-reviewer.md', 'agents/architecture-analyzer.md', 'agents/tour-builder.md', 'agents/graph-reviewer.md'];
  const missing = required.filter(path => !existsSync(join(pluginRoot, path)));
  if (missing.length) throw new Error(`Understand runtime missing at ${pluginRoot}: ${missing.join(', ')}. Use a complete plugin checkout; prepare dependencies and build @understand-anything/core under host policy before retrying. No install or build was run.`);
  try {
    const require = createRequire(join(pluginRoot, 'package.json'));
    require.resolve('graphology');
    require.resolve('graphology-communities-louvain');
    const core = await import(pathToFileURL(join(pluginRoot, 'packages/core/dist/index.js')).href);
    for (const name of ['resolveUaDir', 'TreeSitterPlugin', 'PluginRegistry', 'buildFingerprintStore', 'createIgnoreFilter']) {
      if (!core[name]) throw new Error(`core export missing: ${name}`);
    }
  } catch (error) {
    throw new Error(`Understand runtime cannot load at ${pluginRoot}: ${error.message}. Prepare the plugin's pinned dependencies and core build under host policy, then retry. No install or build was run.`);
  }
  return realpathSync(pluginRoot);
}

export async function resolveContext(args, { cwd = process.cwd(), pluginRoot } = {}) {
  const context = parseArguments(args, cwd);
  context.pluginRoot = await checkRuntime(pluginRoot);
  Object.assign(context, sourceState(context.sourceRoot));
  const meta = readJson(join(context.uaDir, 'meta.json'));
  const graph = readJson(join(context.uaDir, 'knowledge-graph.json'));
  const fingerprints = readJson(join(context.uaDir, 'fingerprints.json'));
  let fullReason;
  if (context.options.full) fullReason = '--full requested';
  else if (!meta || !graph || !fingerprints) fullReason = 'Graph, metadata, or fingerprints missing';
  else if (meta.sourceRoot !== context.sourceRoot) fullReason = 'Previous source root is missing or differs from the selected checkout';
  else if (!context.gitCommitHash || !meta.gitCommitHash) fullReason = 'No reproducible Git commit baseline';
  else if (graph.project?.gitCommitHash !== meta.gitCommitHash || fingerprints.gitCommitHash !== meta.gitCommitHash) fullReason = 'Graph, metadata, and fingerprint commits disagree';
  else if (context.workingTreeDirty || meta.workingTreeDirty !== false) fullReason = 'Current or previous analysis includes uncommitted files';
  context.baselineAction = fullReason ? 'FULL' : (meta.gitCommitHash === context.gitCommitHash ? 'CURRENT' : 'INCREMENTAL');
  context.fullReason = fullReason ?? null;
  context.lastCommitHash = meta?.gitCommitHash ?? null;
  return context;
}

export function assertSourceCommit(sourceRoot, expectedHash) {
  const state = sourceState(sourceRoot);
  if (state.gitCommitHash !== expectedHash) throw new Error('Source HEAD changed during analysis; metadata not advanced');
  return state;
}

export function saveMeta(context) {
  // Re-resolve rather than trusting output paths carried through a model prompt.
  const { sourceRoot, uaDir } = parseArguments([context.sourceRoot]);
  if (sourceRoot !== context.sourceRoot || uaDir !== context.uaDir) throw new Error('Analysis source/data directory changed; metadata not advanced');
  const state = assertSourceCommit(sourceRoot, context.gitCommitHash);
  const graph = readJson(join(uaDir, 'knowledge-graph.json'));
  const fingerprints = readJson(join(uaDir, 'fingerprints.json'));
  const scan = readJson(join(uaDir, 'intermediate', 'scan-result.json'));
  if (!graph || !fingerprints || !Array.isArray(scan?.files)) throw new Error('Saved graph, fingerprints, and scan inventory are required; metadata not advanced');
  if (graph.project?.gitCommitHash !== context.gitCommitHash || fingerprints.gitCommitHash !== context.gitCommitHash) throw new Error('Saved graph/fingerprint commit differs from selected source; metadata not advanced');
  const meta = {
    lastAnalyzedAt: new Date().toISOString(),
    gitCommitHash: context.gitCommitHash,
    sourceRoot,
    gitBranch: state.gitBranch,
    workingTreeDirty: Boolean(context.workingTreeDirty || state.workingTreeDirty),
    version: '1.0.0',
    analyzedFiles: scan.files.length,
  };
  const path = join(uaDir, 'meta.json');
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(meta, null, 2) + '\n');
  renameSync(temp, path);
  return meta;
}

const isCli = process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === '--help' || command === '-h') process.stdout.write(usage + '\n');
    else if (command === 'context') process.stdout.write(JSON.stringify(await resolveContext(args), null, 2) + '\n');
    else if (command === 'save-meta' && args.length === 1) process.stdout.write(JSON.stringify(saveMeta(readJson(args[0])), null, 2) + '\n');
    else throw new Error(usage);
  } catch (error) {
    process.stderr.write(`understand: ${error.message}\n`);
    process.exitCode = 1;
  }
}
