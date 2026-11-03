#!/usr/bin/env node
// Read-only preflight: viewing a graph must not require the analysis runtime.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000 , env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`Invalid or unreadable JSON: ${path}`); }
}

export function dashboardContext(project = '.', cwd = process.cwd()) {
  const projectRoot = realpathSync(resolve(cwd, project));
  if (!statSync(projectRoot).isDirectory()) throw new Error(`Project path is not a directory: ${projectRoot}`);
  const uaDir = join(projectRoot, existsSync(join(projectRoot, '.understand-anything')) ? '.understand-anything' : '.ua');
  if (existsSync(uaDir) && !statSync(uaDir).isDirectory()) throw new Error(`Data path is not a directory: ${uaDir}`);
  const files = ['knowledge-graph.json', 'domain-graph.json'].filter(file => existsSync(join(uaDir, file)));
  if (!files.length) throw new Error(`No knowledge or domain graph found in ${uaDir}. Run /understand or /understand-domain first.`);

  const head = git(projectRoot, ['rev-parse', '--verify', 'HEAD']);
  const status = git(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude).ua', ':(exclude).understand-anything']);
  const warnings = [];
  if (!head || status === null) warnings.push('Git state unavailable; graph freshness is unverified.');
  else if (status) warnings.push('Current checkout has uncommitted changes; graph may omit current code.');
  let meta;
  if (existsSync(join(uaDir, 'meta.json'))) {
    try { meta = readJson(join(uaDir, 'meta.json')); }
    catch (error) { warnings.push(error.message); }
  }
  const graphs = files.map(file => {
    const graph = readJson(join(uaDir, file));
    if (!graph || typeof graph !== 'object' || !graph.project || typeof graph.project !== 'object' || Array.isArray(graph.project) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
      throw new Error(`Invalid graph structure: ${join(uaDir, file)}`);
    }
    const stamp = graph.project;
    // Code-analysis metadata may bind this graph only when its commit agrees.
    const binding = typeof stamp.sourceRoot === 'string' ? stamp
      : meta?.gitCommitHash === stamp.gitCommitHash ? meta : undefined;
    if (!binding?.sourceRoot) warnings.push(`${file}: source checkout is unbound; freshness is unverified.`);
    else if (binding.sourceRoot !== projectRoot) warnings.push(`${file}: source checkout differs (${binding.sourceRoot}); graph may be copied.`);
    if (binding?.workingTreeDirty !== false) warnings.push(`${file}: analysis working-tree state is dirty or unknown.`);
    if (!stamp.gitCommitHash) warnings.push(`${file}: analysis commit is missing.`);
    else if (head && stamp.gitCommitHash !== head) warnings.push(`${file}: analysis commit differs from selected checkout HEAD.`);
    return { path: join(uaDir, file), gitCommitHash: stamp.gitCommitHash ?? null, analyzedAt: stamp.analyzedAt ?? null };
  });
  return { projectRoot, uaDir, head, graphs, warnings };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    let args = process.argv.slice(2);
    if (args[0] === '--') args = args.slice(1);
    if (args.length > 1) throw new Error('Supply only one project directory');
    console.log(JSON.stringify(dashboardContext(args[0]), null, 2));
  } catch (error) {
    console.error(`understand-dashboard: ${error.message}`);
    process.exitCode = 1;
  }
}
