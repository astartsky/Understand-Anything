#!/usr/bin/env node
// Read-only, bounded onboarding overview. Graph loading and freshness come from the
// sibling understand-chat helper so every consumer applies the same source checks.
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectGraph, serializeContext } from '../understand-chat/graph-context.mjs';

const usage = 'Usage: node onboard-context.mjs PROJECT_ROOT [--limit N]';
const FILE_LEVEL = new Set(['file', 'config', 'document', 'service', 'pipeline', 'table', 'schema', 'resource', 'endpoint']);
const RUNTIME = new Set(['service', 'pipeline', 'resource']);
const COMPLEXITY = { complex: 2, moderate: 1 };
const TOUR_STEPS = 12;

export function onboardContext(projectRoot = '.', { limit = 5 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer from 1 to 20');
  const { sourceRoot, dataDir, graph, freshness } = inspectGraph(projectRoot);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const degree = new Map();
  for (const { source, target } of graph.edges) for (const id of [source, target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const layers = Array.isArray(graph.layers) ? graph.layers : [];
  const layerOf = new Map();
  for (const layer of layers) for (const id of layer.nodeIds) if (!layerOf.has(id)) layerOf.set(id, layer.name);
  const brief = node => ({ id: node.id, type: node.type, name: node.name, filePath: node.filePath, summary: node.summary, complexity: node.complexity, layer: layerOf.get(node.id) });
  // Most-connected first: a newcomer's first stops are the hubs others depend on.
  const rank = nodes => [...nodes].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  const top = (nodes, n = limit) => rank(nodes).slice(0, n).map(brief);

  const tour = (Array.isArray(graph.tour) ? graph.tour : []).filter(step => step && typeof step === 'object')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return {
    sourceRoot, dataDir, freshness,
    project: { kind: graph.kind ?? 'codebase', ...pick(graph.project, ['name', 'description', 'languages', 'frameworks', 'analyzedAt', 'gitCommitHash']) },
    counts: { nodes: graph.nodes.length, edges: graph.edges.length, layers: layers.length, tourSteps: tour.length },
    runtimeParts: top(graph.nodes.filter(node => RUNTIME.has(node.type))),
    layers: layers.map(layer => {
      const keyNodes = top(layer.nodeIds.map(id => byId.get(id)).filter(node => node && FILE_LEVEL.has(node.type)));
      return { id: layer.id, name: layer.name, description: layer.description, nodeCount: layer.nodeIds.length,
        keyNodes, omittedNodes: layer.nodeIds.length - keyNodes.length };
    }),
    tour: {
      steps: tour.slice(0, TOUR_STEPS).map(step => {
        const nodeIds = Array.isArray(step.nodeIds) ? step.nodeIds : [];
        return { order: step.order, title: step.title, description: step.description,
          nodes: nodeIds.filter(id => byId.has(id)).slice(0, limit).map(id => brief(byId.get(id))),
          missingNodeIds: nodeIds.filter(id => !byId.has(id)) };
      }),
      omittedSteps: Math.max(0, tour.length - TOUR_STEPS),
    },
    concepts: top(graph.nodes.filter(node => node.type === 'concept')),
    hotspots: rank(graph.nodes.filter(node => FILE_LEVEL.has(node.type) && COMPLEXITY[node.complexity]))
      .sort((a, b) => COMPLEXITY[b.complexity] - COMPLEXITY[a.complexity]).slice(0, limit).map(brief),
  };
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
}

function run(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return usage;
  const [projectRoot, ...rest] = args;
  if (!projectRoot || projectRoot.startsWith('--')) throw new Error(usage);
  const options = {};
  if (rest.length) {
    if (rest.length !== 2 || rest[0] !== '--limit') throw new Error(usage);
    options.limit = Number(rest[1]);
  }
  return serializeContext(onboardContext(projectRoot, options));
}

const isCli = process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isCli) {
  try { process.stdout.write(run(process.argv.slice(2)) + '\n'); }
  catch (error) { process.stderr.write(`understand-onboard: ${error.message}\n`); process.exitCode = 1; }
}
