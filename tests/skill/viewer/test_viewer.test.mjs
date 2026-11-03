// End-to-end tests for the standalone viewer (packages/viewer/bin/viewer.mjs).
// Spawns the real server against a fixture project and exercises the token
// gate, graph sanitisation, file-content allowlist, and .ua/legacy resolution.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VIEWER_BIN = join(
  REPO_ROOT,
  "understand-anything-plugin",
  "packages",
  "viewer",
  "bin",
  "viewer.mjs",
);
const VIEWER_DIST = join(REPO_ROOT, "understand-anything-plugin", "packages", "viewer", "dist");

function fixtureGraph(gitCommitHash) {
  return {
    version: "1.0.0",
    project: {
      name: "fixture", languages: ["ts"], frameworks: [], description: "d",
      analyzedAt: "2026-07-17T00:00:00.000Z", gitCommitHash,
    },
    nodes: [
      {
        id: "file:src/a.ts", type: "file", name: "a.ts", filePath: "src/a.ts",
        summary: "s", tags: [], complexity: "simple",
      },
    ],
    edges: [],
    layers: [],
    tour: [],
  };
}

function fixtureDomainGraph(gitCommitHash) {
  const graph = fixtureGraph(gitCommitHash);
  graph.nodes = [
    { id: "domain:orders", type: "domain", name: "Orders", summary: "Order domain", tags: [], complexity: "simple" },
    { id: "flow:checkout", type: "flow", name: "Checkout", summary: "Checkout flow", tags: [], complexity: "simple" },
    { id: "step:confirm", type: "step", name: "Confirm order", summary: "Confirm an order", tags: [], complexity: "simple", filePath: "src/a.ts" },
  ];
  graph.edges = [
    { source: "domain:orders", target: "flow:checkout", type: "contains_flow", direction: "forward", weight: 1 },
    { source: "flow:checkout", target: "step:confirm", type: "flow_step", direction: "forward", weight: 1 },
  ];
  return graph;
}

function git(projectRoot, ...args) {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
  }).trim();
}

function setupProject(dataDirName, domainOnly = false) {
  const root = mkdtempSync(join(tmpdir(), "ua-viewer-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "secret.txt"), "not in graph\n");
  git(root, "init");
  git(root, "config", "user.email", "viewer-tests@example.com");
  git(root, "config", "user.name", "Viewer Tests");
  git(root, "add", "--all");
  git(root, "commit", "-m", "baseline");

  const dataDir = join(root, dataDirName);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, domainOnly ? "domain-graph.json" : "knowledge-graph.json"),
    JSON.stringify((domainOnly ? fixtureDomainGraph : fixtureGraph)(git(root, "rev-parse", "HEAD"))),
  );
  return root;
}

/** Start the viewer and wait for the printed URL. Returns { proc, url, token, port }. */
function startViewer(projectRoot) {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(
      process.execPath,
      [VIEWER_BIN, projectRoot, "--no-open", "--port", "0"],
      { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      proc.kill();
      rejectPromise(new Error(`viewer did not start.\n${out}`));
    }, 10_000);
    const onData = (chunk) => {
      out += String(chunk);
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+)/);
      if (m) {
        clearTimeout(timer);
        resolvePromise({ proc, url: m[0], port: Number(m[1]), token: m[2] });
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`viewer exited with ${code}.\n${out}`));
    });
  });
}

describe.skipIf(!existsSync(VIEWER_DIST))("understand-anything-viewer", () => {
  let root;
  let viewer;

  beforeAll(async () => {
    root = setupProject(".ua");
    viewer = await startViewer(root);
  }, 15_000);

  afterAll(() => {
    viewer?.proc.kill();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${viewer.port}`;

  it("serves the embedded dashboard index", async () => {
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("rejects data requests without the token", async () => {
    const res = await fetch(`${base()}/knowledge-graph.json`);
    expect(res.status).toBe(403);
  });

  it("serves the graph from .ua/ with a valid token", async () => {
    const res = await fetch(`${base()}/knowledge-graph.json?token=${viewer.token}`);
    expect(res.status).toBe(200);
    const graph = await res.json();
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].filePath).toBe("src/a.ts");
  });

  it("serves a protected no-store freshness report", async () => {
    const denied = await fetch(`${base()}/staleness.json`);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");

    const res = await fetch(
      `${base()}/staleness.json?token=${viewer.token}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      graphs: {
        knowledge: {
          status: "fresh",
          graphCommitHash: git(root, "rev-parse", "HEAD"),
          headCommitHash: git(root, "rev-parse", "HEAD"),
        },
      },
    });
  });

  it("serves file content only for files listed in the graph", async () => {
    const ok = await fetch(
      `${base()}/file-content.json?token=${viewer.token}&path=${encodeURIComponent("src/a.ts")}`,
    );
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.content).toContain("export const a");
    expect(body.language).toBe("typescript");

    const denied = await fetch(
      `${base()}/file-content.json?token=${viewer.token}&path=secret.txt`,
    );
    expect(denied.status).toBe(404);
  });

  it("rejects path traversal in file-content", async () => {
    const res = await fetch(
      `${base()}/file-content.json?token=${viewer.token}&path=${encodeURIComponent("../outside.txt")}`,
    );
    expect(res.status).toBe(400);
  });

  it("blocks static requests escaping dist/", async () => {
    const res = await fetch(`${base()}/%2e%2e/package.json`);
    expect([403, 404]).toContain(res.status);
  });

  it("refuses a diff snapshot for a different graph and fingerprints bytes before sanitization", async () => {
    const graphPath = join(root, ".ua", "knowledge-graph.json");
    const overlayPath = join(root, ".ua", "diff-overlay.json");
    const original = readFileSync(graphPath);
    const graph = JSON.parse(original.toString("utf8"));
    graph.nodes[0].filePath = join(root, "src", "a.ts");
    writeFileSync(graphPath, JSON.stringify(graph, null, 2) + "\n");
    const rawHash = createHash("sha256").update(readFileSync(graphPath)).digest("hex");
    const snapshot = { graphContentHash: rawHash, sourceRoot: root, headCommitHash: "b".repeat(40), workingTreeHash: "c".repeat(64), generatedAt: "2026-11-03T12:00:00Z", changedNodeIds: ["file:src/a.ts"], affectedNodeIds: [] };
    writeFileSync(overlayPath, JSON.stringify({ ...snapshot, graphContentHash: "0".repeat(64) }));
    try {
      const rejected = await fetch(`${base()}/diff-overlay.json?token=${viewer.token}`);
      expect(rejected.status).toBe(409);
      const served = await fetch(`${base()}/knowledge-graph.json?token=${viewer.token}`);
      expect(served.headers.get("x-understand-graph-hash")).toBe(rawHash);
      expect(served.headers.get("cache-control")).toBe("no-store");
      const servedBody = await served.text();
      expect(createHash("sha256").update(servedBody).digest("hex")).not.toBe(rawHash);
      expect(JSON.parse(servedBody).nodes[0].filePath).toBe("src/a.ts");
      writeFileSync(overlayPath, JSON.stringify(snapshot));
      expect((await fetch(`${base()}/diff-overlay.json?token=${viewer.token}`)).status).toBe(200);
      writeFileSync(overlayPath, JSON.stringify({ ...snapshot, changedNodeIds: [], affectedNodeIds: [] }));
      expect((await fetch(`${base()}/diff-overlay.json?token=${viewer.token}`)).status).toBe(200);
      graph.project.description = "a new graph";
      writeFileSync(graphPath, JSON.stringify(graph));
      expect((await fetch(`${base()}/diff-overlay.json?token=${viewer.token}`)).status).toBe(409);
    } finally {
      rmSync(overlayPath, { force: true });
      writeFileSync(graphPath, original);
    }
  });

  it("serves domain-only projects and their freshness without a code graph", async () => {
    const domainRoot = setupProject(".ua", true);
    let domainViewer;
    try {
      domainViewer = await startViewer(domainRoot);
      const base = `http://127.0.0.1:${domainViewer.port}`;
      const domain = await fetch(`${base}/domain-graph.json?token=${domainViewer.token}`);
      expect(domain.status).toBe(200);
      expect((await domain.json()).nodes.map(node => node.type)).toEqual(["domain", "flow", "step"]);
      const source = await fetch(`${base}/file-content.json?token=${domainViewer.token}&path=src/a.ts`);
      expect(source.status).toBe(200);
      expect((await source.json()).content).toContain("export const a = 1");
      expect((await fetch(`${base}/file-content.json?path=src/a.ts`)).status).toBe(403);
      expect((await fetch(`${base}/file-content.json?token=${domainViewer.token}&path=secret.txt`)).status).toBe(404);
      expect((await fetch(`${base}/knowledge-graph.json?token=${domainViewer.token}`)).status).toBe(404);
      const freshness = await fetch(`${base}/staleness.json?token=${domainViewer.token}`);
      expect(freshness.status).toBe(200);
      const report = await freshness.json();
      expect(report.graphs.domain.status).toBe("fresh");
      expect(report.graphs).not.toHaveProperty("knowledge");
    } finally {
      domainViewer?.proc.kill();
      rmSync(domainRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("uses the selected graph union and rejects graph-listed symlinks escaping the project", async () => {
    const unionRoot = setupProject(".ua");
    const outside = `${unionRoot}-outside.ts`;
    const outsideDir = `${unionRoot}-outside-dir`;
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "secret.ts"), "outside directory must not be served\n");
    symlinkSync(outsideDir, join(unionRoot, "src", "external"));
    const domainPath = join(unionRoot, ".ua", "domain-graph.json");
    writeFileSync(join(unionRoot, "src", "domain.ts"), "export const domainSource = true;\n");
    writeFileSync(outside, "outside must not be served\n");
    symlinkSync(outside, join(unionRoot, "src", "escape.ts"));
    const domain = fixtureDomainGraph(git(unionRoot, "rev-parse", "HEAD"));
    domain.nodes.find(node => node.type === "step").filePath = "src/domain.ts";
    domain.nodes.push({ ...domain.nodes[2], id: "step:escape", filePath: "src/escape.ts" });
    domain.nodes.push({ ...domain.nodes[2], id: "step:parent-escape", filePath: "src/external/secret.ts" });
    domain.nodes.push({ ...domain.nodes[2], id: "step:inside-alias", filePath: "src/alias.ts" });
    symlinkSync(join(unionRoot, "src", "domain.ts"), join(unionRoot, "src", "alias.ts"));
    domain.nodes.push({ ...domain.nodes[2], id: "step:binary", filePath: "src/binary.ts" });
    domain.nodes.push({ ...domain.nodes[2], id: "step:large", filePath: "src/large.ts" });
    writeFileSync(join(unionRoot, "src", "binary.ts"), Buffer.from([65, 0, 66]));
    writeFileSync(join(unionRoot, "src", "large.ts"), Buffer.alloc(1024 * 1024 + 1, 65));
    writeFileSync(domainPath, JSON.stringify(domain));
    const knowledgePath = join(unionRoot, ".ua", "knowledge-graph.json");
    const knowledge = JSON.parse(readFileSync(knowledgePath, "utf8"));
    knowledge.nodes.push({ ...knowledge.nodes[0], id: "file:escape", filePath: "src/escape.ts" });
    knowledge.nodes.push({ ...knowledge.nodes[0], id: "file:parent-escape", filePath: "src/external/secret.ts" });
    writeFileSync(knowledgePath, JSON.stringify(knowledge));
    let unionViewer;
    try {
      unionViewer = await startViewer(unionRoot);
      const source = path => fetch(`http://127.0.0.1:${unionViewer.port}/file-content.json?token=${unionViewer.token}&path=${encodeURIComponent(path)}`);
      expect((await source("src/a.ts")).status).toBe(200);
      expect((await source("src/escape.ts")).status).toBe(400);
      expect((await source("src/external/secret.ts")).status).toBe(400);
      expect((await source("src/domain.ts")).status).toBe(200);
      expect((await source("src/alias.ts")).status).toBe(200);
      expect((await source("src/binary.ts")).status).toBe(415);
      expect((await source("src/large.ts")).status).toBe(413);
      expect((await source("../outside.ts")).status).toBe(400);
      expect((await source("secret.txt")).status).toBe(404);
    } finally {
      unionViewer?.proc.kill();
      rmSync(unionRoot, { recursive: true, force: true });
      rmSync(outside, { force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("does not load .ua when an existing legacy data directory is empty", async () => {
    const mixedRoot = setupProject(".ua");
    mkdirSync(join(mixedRoot, ".understand-anything"));
    let unexpected;
    try {
      await expect(startViewer(mixedRoot).then(value => { unexpected = value; return value; })).rejects.toThrow(/no.*graph/i);
    } finally {
      unexpected?.proc.kill();
      rmSync(mixedRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("falls back to legacy .understand-anything/ projects", async () => {
    const legacyRoot = setupProject(".understand-anything");
    const legacyViewer = await startViewer(legacyRoot);
    try {
      const res = await fetch(
        `http://127.0.0.1:${legacyViewer.port}/knowledge-graph.json?token=${legacyViewer.token}`,
      );
      expect(res.status).toBe(200);
      expect((await res.json()).nodes).toHaveLength(1);
    } finally {
      legacyViewer.proc.kill();
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
