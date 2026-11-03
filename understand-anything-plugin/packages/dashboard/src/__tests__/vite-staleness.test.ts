import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import fs from "node:fs";
import {
  createServer,
  request as httpRequest,
  type Server,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardDataMiddleware } from "../../vite.config";
import { isDashboardFreshnessReport } from "../freshness";

interface HttpResult {
  status: number;
  body: unknown;
  cacheControl: string | null;
}

let originalGraphDir: string | undefined;
let tempProject: string;
let baselineCommit: string;
let restoreCwd: (() => void) | undefined;
const servers: Server[] = [];
const viteServers: ViteDevServer[] = [];
let originalAccessToken: string | undefined;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: tempProject,
    encoding: "utf8",
  }).trim();
}

function writeProjectFile(relativePath: string, contents: string): void {
  const filePath = path.join(tempProject, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function commitAll(message: string): string {
  git("add", "--all");
  git("commit", "-m", message);
  return git("rev-parse", "HEAD");
}

function graphDirectory(dataDir = ".understand-anything"): string {
  const directory = path.join(tempProject, dataDir);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function writeGraph(
  fileName: "knowledge-graph.json" | "domain-graph.json",
  commitHash: string,
  dataDir = ".understand-anything",
): void {
  fs.writeFileSync(
    path.join(graphDirectory(dataDir), fileName),
    JSON.stringify({
      project: {
        gitCommitHash: commitHash,
        analyzedAt: "2026-07-10T00:00:00.000Z",
      },
      nodes: [],
      edges: [],
    }),
    "utf8",
  );
}

async function startDashboardServer(accessToken: string): Promise<string> {
  const middleware = createDashboardDataMiddleware(accessToken);
  const server = createServer((req, res) => {
    middleware(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Dashboard test server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

function requestJson(baseUrl: string, requestPath: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${baseUrl}${requestPath}`,
      { agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: text.length > 0 ? JSON.parse(text) : null,
            cacheControl: response.headers["cache-control"] ?? null,
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

beforeEach(() => {
  originalGraphDir = process.env.GRAPH_DIR;
  originalAccessToken = process.env.UNDERSTAND_ACCESS_TOKEN;
  tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "ua-dashboard-"));
  process.env.GRAPH_DIR = tempProject;
  // Keep both cwd fallback roots inside the fixture. A developer's existing
  // knowledge graph must not satisfy this suite's missing-graph request.
  const fixtureCwd = path.join(tempProject, "runtime", "a", "b");
  fs.mkdirSync(fixtureCwd, { recursive: true });
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(fixtureCwd);
  restoreCwd = () => cwd.mockRestore();

  git("init");
  git("config", "user.email", "dashboard-tests@example.com");
  git("config", "user.name", "Dashboard Tests");
  writeProjectFile("src/index.ts", "export const value = 1;\n");
  baselineCommit = commitAll("baseline");
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of viteServers.splice(0)) await server.close();
  if (originalAccessToken === undefined) delete process.env.UNDERSTAND_ACCESS_TOKEN;
  else process.env.UNDERSTAND_ACCESS_TOKEN = originalAccessToken;
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  restoreCwd?.();
  restoreCwd = undefined;
  if (originalGraphDir === undefined) {
    delete process.env.GRAPH_DIR;
  } else {
    process.env.GRAPH_DIR = originalGraphDir;
  }
  fs.rmSync(tempProject, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

describe(
  "dashboard graph freshness endpoint",
  { timeout: 15_000 },
  () => {
    it("rejects an unauthorized request before serving freshness data", async () => {
      writeGraph("knowledge-graph.json", baselineCommit);
      const baseUrl = await startDashboardServer("test-token");

      await expect(requestJson(baseUrl, "/staleness.json")).resolves.toEqual({
        status: 403,
        body: { error: "Forbidden: missing or invalid token" },
        cacheControl: "no-store",
      });
    });

    it.each([".understand-anything", ".ua"])(
      "serves a knowledge-only report from %s to an authorized request",
      async (dataDir) => {
        writeGraph("knowledge-graph.json", baselineCommit, dataDir);
        const baseUrl = await startDashboardServer("test-token");

        const response = await requestJson(
          baseUrl,
          "/staleness.json?token=test-token",
        );

        expect(response.status).toBe(200);
        expect(response.cacheControl).toBe("no-store");
        expect(isDashboardFreshnessReport(response.body)).toBe(true);
        expect(response.body).toMatchObject({
          graphs: {
            knowledge: {
              status: "fresh",
              graphCommitHash: baselineCommit,
              headCommitHash: baselineCommit,
            },
          },
        });
        expect(
          (response.body as { graphs: Record<string, unknown> }).graphs,
        ).not.toHaveProperty("domain");
      },
    );

    it("serves freshness for a domain-only project", async () => {
      writeGraph("domain-graph.json", baselineCommit, ".ua");
      const baseUrl = await startDashboardServer("test-token");
      const response = await requestJson(baseUrl, "/staleness.json?token=test-token");
      expect(response.status).toBe(200);
      expect(isDashboardFreshnessReport(response.body)).toBe(true);
      expect(response.body).toMatchObject({ graphs: { domain: { status: "fresh" } } });
      expect((response.body as { graphs: object }).graphs).not.toHaveProperty("knowledge");
    });

    it("does not mix .ua data into an existing legacy directory", async () => {
      writeGraph("knowledge-graph.json", baselineCommit, ".ua");
      graphDirectory();
      const baseUrl = await startDashboardServer("test-token");
      expect((await requestJson(baseUrl, "/staleness.json?token=test-token")).status).toBe(404);
    });

    it("does not fall back to cwd when GRAPH_DIR selects another project", async () => {
      writeGraph("knowledge-graph.json", baselineCommit, ".ua");
      vi.spyOn(process, "cwd").mockReturnValue(tempProject);
      process.env.GRAPH_DIR = path.join(tempProject, "other-project");
      fs.mkdirSync(process.env.GRAPH_DIR);
      const baseUrl = await startDashboardServer("test-token");
      expect((await requestJson(baseUrl, "/staleness.json?token=test-token")).status).toBe(404);
      vi.restoreAllMocks();
    });

    it("reports knowledge and domain graph freshness independently", async () => {
      writeProjectFile("src/index.ts", "export const value = 2;\n");
      const headCommit = commitAll("project change");
      writeGraph("knowledge-graph.json", headCommit);
      writeGraph("domain-graph.json", baselineCommit);
      const baseUrl = await startDashboardServer("test-token");

      const response = await requestJson(
        baseUrl,
        "/staleness.json?token=test-token",
      );
      expect(isDashboardFreshnessReport(response.body)).toBe(true);
      expect(response).toMatchObject({
        status: 200,
        body: {
          graphs: {
            knowledge: {
              status: "fresh",
              graphCommitHash: headCommit,
            },
            domain: {
              status: "stale",
              relation: "behind",
              graphCommitHash: baselineCommit,
              headCommitHash: headCommit,
              commitsBehind: 1,
              changedFiles: ["src/index.ts"],
            },
          },
        },
      });
    });

    it("returns 404 when both supported graphs are missing", async () => {
      const baseUrl = await startDashboardServer("test-token");

      await expect(
        requestJson(baseUrl, "/staleness.json?token=test-token"),
      ).resolves.toEqual({
        status: 404,
        body: { error: "No knowledge or domain graph found. Run /understand or /understand-domain first." },
        cacheControl: "no-store",
      });
    });

    it("returns a safe 500 response for invalid knowledge graph JSON", async () => {
      fs.writeFileSync(
        path.join(graphDirectory(), "knowledge-graph.json"),
        "{not-json",
        "utf8",
      );
      const baseUrl = await startDashboardServer("test-token");

      await expect(
        requestJson(baseUrl, "/staleness.json?token=test-token"),
      ).resolves.toEqual({
        status: 500,
        body: { error: "Failed to read graph file" },
        cacheControl: "no-store",
      });
    });

    it("returns a safe 500 response for invalid optional domain graph JSON", async () => {
      writeGraph("knowledge-graph.json", baselineCommit);
      fs.writeFileSync(
        path.join(graphDirectory(), "domain-graph.json"),
        "{not-json",
        "utf8",
      );
      const baseUrl = await startDashboardServer("test-token");

      await expect(
        requestJson(baseUrl, "/staleness.json?token=test-token"),
      ).resolves.toEqual({
        status: 500,
        body: { error: "Failed to read graph file" },
        cacheControl: "no-store",
      });
    });
  },
);


async function startFullDashboardServer(): Promise<string> {
  process.env.UNDERSTAND_ACCESS_TOKEN = "source-test-token";
  const dashboardRoot = fileURLToPath(new URL("../../", import.meta.url));
  const server = await createViteServer({
    root: dashboardRoot,
    configFile: path.join(dashboardRoot, "vite.config.ts"),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, open: false },
  });
  viteServers.push(server);
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("No Vite source-preview port");
  return `http://127.0.0.1:${address.port}`;
}

function writeDomainGraph(dataDir = ".ua"): void {
  fs.writeFileSync(path.join(graphDirectory(dataDir), "domain-graph.json"), JSON.stringify({
    version: "1.0.0",
    project: { name: "Orders", languages: ["TypeScript"], frameworks: [], description: "Order flow", gitCommitHash: baselineCommit, analyzedAt: "2026-11-03T12:00:00Z" },
    nodes: [
      { id: "domain:orders", type: "domain", name: "Orders", summary: "Orders", tags: [], complexity: "simple" },
      { id: "flow:checkout", type: "flow", name: "Checkout", summary: "Checkout", tags: [], complexity: "simple" },
      { id: "step:confirm", type: "step", name: "Confirm", summary: "Confirm", tags: [], complexity: "simple", filePath: "src/index.ts" },
      { id: "step:escape", type: "step", name: "Escape", summary: "Untrusted graph path", tags: [], complexity: "simple", filePath: "src/escape.ts" },
    ],
    edges: [
      { source: "domain:orders", target: "flow:checkout", type: "contains_flow", direction: "forward", weight: 1 },
      { source: "flow:checkout", target: "step:confirm", type: "flow_step", direction: "forward", weight: 1 },
    ], layers: [], tour: [],
  }));
}

describe("domain source preview through the real Vite endpoint", { timeout: 20_000 }, () => {
  it("serves an authenticated domain step source and refuses unrelated files", async () => {
    writeDomainGraph();
    writeProjectFile("secret.txt", "not in a graph");
    const base = await startFullDashboardServer();
    expect((await requestJson(base, "/file-content.json?path=src/index.ts")).status).toBe(403);
    const response = await requestJson(base, "/file-content.json?token=source-test-token&path=src/index.ts");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ path: "src/index.ts", content: "export const value = 1;\n" });
    expect((await requestJson(base, "/file-content.json?token=source-test-token&path=secret.txt")).status).toBe(404);
    expect((await requestJson(base, "/file-content.json?token=source-test-token&path=../secret.txt")).status).toBe(400);
  });

  it("uses the graph union only inside the selected data directory", async () => {
    writeDomainGraph();
    writeProjectFile("src/code.ts", "export const code = true;\n");
    const knowledge = JSON.stringify({ project: { gitCommitHash: baselineCommit }, nodes: [{ id: "file:code", filePath: "src/code.ts" }], edges: [] });
    fs.writeFileSync(path.join(graphDirectory(".ua"), "knowledge-graph.json"), knowledge);
    const base = await startFullDashboardServer();
    const source = (file: string) => requestJson(base, `/file-content.json?token=source-test-token&path=${encodeURIComponent(file)}`);
    expect((await source("src/code.ts")).status).toBe(200);
    expect((await source("src/index.ts")).status).toBe(200);
    fs.writeFileSync(path.join(graphDirectory(), "knowledge-graph.json"), knowledge);
    expect((await source("src/code.ts")).status).toBe(200);
    expect((await source("src/index.ts")).status).toBe(404);
  });

  it("preserves binary and size refusal for domain-listed sources", async () => {
    writeDomainGraph();
    const graphPath = path.join(graphDirectory(".ua"), "domain-graph.json");
    const domain = JSON.parse(fs.readFileSync(graphPath, "utf8"));
    domain.nodes.push({ ...domain.nodes[2], id: "step:binary", filePath: "src/binary.ts" });
    domain.nodes.push({ ...domain.nodes[2], id: "step:large", filePath: "src/large.ts" });
    fs.writeFileSync(graphPath, JSON.stringify(domain));
    fs.writeFileSync(path.join(tempProject, "src", "binary.ts"), Buffer.from([65, 0, 66]));
    fs.writeFileSync(path.join(tempProject, "src", "large.ts"), Buffer.alloc(1024 * 1024 + 1, 65));
    const base = await startFullDashboardServer();
    expect((await requestJson(base, "/file-content.json?token=source-test-token&path=src/binary.ts")).status).toBe(415);
    expect((await requestJson(base, "/file-content.json?token=source-test-token&path=src/large.ts")).status).toBe(413);
  });

  it("rejects a graph-listed source symlink outside the selected project", async () => {
    writeDomainGraph();
    const outside = `${tempProject}-outside.ts`;
    fs.writeFileSync(outside, "outside must not be served");
    fs.symlinkSync(outside, path.join(tempProject, "src", "escape.ts"));
    const outsideDir = `${tempProject}-outside-dir`;
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "secret.ts"), "outside directory must not be served");
    fs.symlinkSync(outsideDir, path.join(tempProject, "src", "external"));
    fs.writeFileSync(path.join(graphDirectory(".ua"), "knowledge-graph.json"), JSON.stringify({
      project: { gitCommitHash: baselineCommit }, nodes: [{ id: "file:escape", type: "file", filePath: "src/escape.ts" }, { id: "file:parent-escape", type: "file", filePath: "src/external/secret.ts" }], edges: [],
    }));
    try {
      const base = await startFullDashboardServer();
      const response = await requestJson(base, "/file-content.json?token=source-test-token&path=src/escape.ts");
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain("outside must not be served");
      const parentEscape = await requestJson(base, "/file-content.json?token=source-test-token&path=src/external/secret.ts");
      expect(parentEscape.status).toBe(400);
      expect(JSON.stringify(parentEscape.body)).not.toContain("outside directory must not be served");
    } finally {
      fs.rmSync(outside, { force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
