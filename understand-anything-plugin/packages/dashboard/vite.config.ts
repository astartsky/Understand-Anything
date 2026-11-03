/// <reference types="vitest" />
import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import {
  getGraphFreshnessBatch,
  type GraphFreshnessInput,
  type GraphFreshnessResult,
} from "../core/src/staleness";

// Generate a one-time token when the server process starts.
// This token is printed to the terminal and must be in the URL
// to fetch knowledge-graph.json or diff-overlay.json.
const ACCESS_TOKEN = process.env.UNDERSTAND_ACCESS_TOKEN || crypto.randomBytes(16).toString("hex");
const MAX_SOURCE_FILE_BYTES = 1024 * 1024;

// Legacy directory first — projects analyzed before the `.ua` rename keep
// their existing `.understand-anything/` data.
function graphFileCandidates(fileName: string): string[] {
  // GRAPH_DIR selects a project, never a hint for falling back to another checkout.
  const projectRoot = path.resolve(process.env.GRAPH_DIR ?? process.cwd());
  const dataDir = fs.existsSync(path.join(projectRoot, ".understand-anything"))
    ? ".understand-anything" : ".ua";
  return [path.join(projectRoot, dataDir, fileName)];
}

function findGraphFile(fileName: string): string | null {
  return graphFileCandidates(fileName).find((candidate) => fs.existsSync(candidate)) ?? null;
}

function projectRootFromGraphFile(candidate: string): string {
  return path.dirname(path.dirname(candidate));
}

function normalizeGraphPath(filePath: string, projectRoot: string): string | null {
  const rawPath = path.isAbsolute(filePath)
    ? filePath.startsWith(projectRoot)
      ? path.relative(projectRoot, filePath)
      : null
    : filePath;
  if (rawPath === null) return null;
  const normalized = path.normalize(rawPath);
  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("\0") ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized.split(path.sep).join("/");
}

function graphFilePathSet(graphFiles: string[], projectRoot: string): Set<string> {
  const allowed = new Set<string>();
  for (const graphFile of graphFiles) {
    try {
      const raw = JSON.parse(fs.readFileSync(graphFile, "utf-8")) as {
        nodes?: Array<Record<string, unknown> | null>;
      };
      if (!Array.isArray(raw?.nodes)) continue;
      for (const node of raw.nodes) {
        if (!node || typeof node.filePath !== "string") continue;
        const normalized = normalizeGraphPath(node.filePath, projectRoot);
        if (normalized) allowed.add(normalized);
      }
    } catch {
      // A missing or unreadable graph grants no paths; the other graph is independent.
    }
  }
  return allowed;
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const byExt: Record<string, string> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "markup",
    java: "java",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    ts: "typescript",
    tsx: "tsx",
    txt: "text",
    yaml: "yaml",
    yml: "yaml",
  };
  return byExt[ext] ?? "text";
}

function sendJson(res: import("http").ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function rejectFileRequest(message: string, statusCode = 400) {
  return { statusCode, payload: { error: message } };
}

function readSourceFile(url: URL) {
  const requestedPath = url.searchParams.get("path") ?? "";
  if (!requestedPath) return rejectFileRequest("Missing path");
  if (requestedPath.includes("\0")) return rejectFileRequest("Invalid path");
  if (path.isAbsolute(requestedPath)) return rejectFileRequest("Absolute paths are not allowed");

  const normalizedPath = path.normalize(requestedPath);
  if (
    normalizedPath === "." ||
    normalizedPath.startsWith(`..${path.sep}`) ||
    normalizedPath === ".." ||
    path.isAbsolute(normalizedPath)
  ) {
    return rejectFileRequest("Path must stay inside the project");
  }

  const graphFiles = ["knowledge-graph.json", "domain-graph.json"]
    .map(findGraphFile).filter((file): file is string => file !== null);
  if (graphFiles.length === 0) {
    return rejectFileRequest("No knowledge or domain graph found. Run /understand or /understand-domain first.", 404);
  }

  const projectRoot = path.resolve(process.env.GRAPH_DIR ?? process.cwd());
  const absoluteFile = path.resolve(projectRoot, normalizedPath);
  const relativeToRoot = path.relative(projectRoot, absoluteFile);
  if (
    !relativeToRoot ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    relativeToRoot === ".." ||
    path.isAbsolute(relativeToRoot)
  ) {
    return rejectFileRequest("Path must stay inside the project");
  }
  const safeRelativePath = relativeToRoot.split(path.sep).join("/");
  if (!graphFilePathSet(graphFiles, projectRoot).has(safeRelativePath)) {
    return rejectFileRequest("File is not in the selected graphs", 404);
  }

  let stat: fs.Stats;
  let physicalFile: string;
  try {
    physicalFile = fs.realpathSync(absoluteFile);
    const physicalRoot = fs.realpathSync(projectRoot);
    const physicalRelative = path.relative(physicalRoot, physicalFile);
    if (!physicalRelative || physicalRelative === ".." || physicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(physicalRelative)) {
      return rejectFileRequest("Path must stay inside the project");
    }
    stat = fs.statSync(physicalFile);
  } catch {
    return rejectFileRequest("File not found", 404);
  }

  if (!stat.isFile()) return rejectFileRequest("Path is not a file");
  if (stat.size > MAX_SOURCE_FILE_BYTES) {
    return rejectFileRequest("File is too large to preview", 413);
  }

  const buffer = fs.readFileSync(physicalFile);
  if (buffer.includes(0)) return rejectFileRequest("Binary files cannot be previewed", 415);

  const content = buffer.toString("utf8");
  return {
    statusCode: 200,
    payload: {
      path: safeRelativePath,
      language: detectLanguage(relativeToRoot),
      content,
      sizeBytes: buffer.byteLength,
      lineCount: content.length === 0 ? 0 : content.split(/\r\n|\n|\r/).length,
    },
  };
}

export interface DashboardFreshnessReport {
  graphs: {
    knowledge?: GraphFreshnessResult;
    domain?: GraphFreshnessResult;
  };
}

function readGraphMetadata(graphFile: string): GraphFreshnessInput {
  const graph = JSON.parse(fs.readFileSync(graphFile, "utf-8")) as {
    project?: {
      gitCommitHash?: unknown;
      analyzedAt?: unknown;
    };
  };
  return {
    graphCommitHash:
      typeof graph.project?.gitCommitHash === "string"
        ? graph.project.gitCommitHash
        : undefined,
    lastAnalyzedAt:
      typeof graph.project?.analyzedAt === "string"
        ? graph.project.analyzedAt
        : undefined,
  };
}

export async function readGraphFreshness() {
  const inputs: Record<string, GraphFreshnessInput> = {};
  try {
    for (const [name, file] of [["knowledge", "knowledge-graph.json"], ["domain", "domain-graph.json"]]) {
      const graphFile = findGraphFile(file);
      if (graphFile) inputs[name] = readGraphMetadata(graphFile);
    }
  } catch {
    return rejectFileRequest("Failed to read graph file", 500);
  }
  if (Object.keys(inputs).length === 0) {
    return rejectFileRequest("No knowledge or domain graph found. Run /understand or /understand-domain first.", 404);
  }
  const projectRoot = path.resolve(process.env.GRAPH_DIR ?? process.cwd());
  const graphs: DashboardFreshnessReport["graphs"] = await getGraphFreshnessBatch(projectRoot, inputs);

  return {
    statusCode: 200,
    payload: { graphs } satisfies DashboardFreshnessReport,
  };
}

type DashboardDataMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

export function createDashboardDataMiddleware(
  accessToken: string,
): DashboardDataMiddleware {
  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1:5173");
    if (url.pathname !== "/staleness.json") {
      next();
      return;
    }

    res.setHeader("Cache-Control", "no-store");

    if (url.searchParams.get("token") !== accessToken) {
      sendJson(res, 403, { error: "Forbidden: missing or invalid token" });
      return;
    }

    void readGraphFreshness()
      .then((result) => sendJson(res, result.statusCode, result.payload))
      .catch(() => {
        sendJson(res, 500, { error: "Failed to read graph freshness" });
      });
  };
}

type DashboardViteConfig = UserConfig & {
  test: {
    environment: "node";
    include: string[];
  };
};

const config: DashboardViteConfig = {
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },

  // FIX 1 — bind only to localhost, not 0.0.0.0
  // This blocks access from any other device on the same LAN / WiFi.
  server: {
    host: "127.0.0.1",
    port: 5173,
    open: `/?token=${ACCESS_TOKEN}`,
  },

  resolve: {
    alias: {
      "@understand-anything/core/schema": path.resolve(__dirname, "../core/dist/schema.js"),
      "@understand-anything/core/search": path.resolve(__dirname, "../core/dist/search.js"),
      "@understand-anything/core/types": path.resolve(__dirname, "../core/dist/types.js"),
    },
  },

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react-vendor";
          }
          if (id.includes("node_modules/@xyflow/")) return "xyflow";
          // ELK is ~1.6MB raw — split into its own chunk so it doesn't
          // bloat the main bundle. graphology is similarly large.
          if (id.includes("node_modules/elkjs/")) return "elk";
          if (id.includes("node_modules/graphology")) return "graphology";
          if (
            id.includes("node_modules/@dagrejs/") ||
            id.includes("node_modules/d3-force/")
          ) {
            return "graph-layout";
          }
          if (
            id.includes("node_modules/react-markdown/") ||
            id.includes("node_modules/hast-util-to-jsx-runtime/") ||
            /[\\/]node_modules[\\/](remark|rehype|mdast|hast|unist|micromark|decode-named-character-reference|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|devlop|bail|ccount|character-entities|is-plain-obj|trim-lines|trough|unified|vfile|zwitch)/.test(id)
          ) {
            return "markdown";
          }
        },
      },
    },
  },

  plugins: [
    react(),
    tailwindcss(),
    {
      name: "serve-knowledge-graph",
      configureServer(server) {
        // Print the access URL once so the developer can open it.
        server.httpServer?.once("listening", () => {
          const address = server.httpServer?.address();
          const port = typeof address === "object" && address ? address.port : 5173;
          console.log(
            `\n  🔑  Dashboard URL: http://127.0.0.1:${port}/?token=${ACCESS_TOKEN}\n`
          );
        });

        server.middlewares.use(createDashboardDataMiddleware(ACCESS_TOKEN));

        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1:5173");
          const pathname = url.pathname;
          const isProtectedEndpoint =
            pathname === "/knowledge-graph.json" ||
            pathname === "/domain-graph.json" ||
            pathname === "/diff-overlay.json" ||
            pathname === "/meta.json" ||
            pathname === "/config.json" ||
            pathname === "/file-content.json";

          if (!isProtectedEndpoint) {
            next();
            return;
          }

          // FIX 3 — require the one-time token on all data endpoints.
          // Requests without a matching ?token= get a 403.
          if (url.searchParams.get("token") !== ACCESS_TOKEN) {
            sendJson(res, 403, { error: "Forbidden: missing or invalid token" });
            return;
          }

          if (pathname === "/file-content.json") {
            const result = readSourceFile(url);
            sendJson(res, result.statusCode, result.payload);
            return;
          }

          if (pathname === "/config.json") {
            const configCandidates = graphFileCandidates("config.json");
            for (const candidate of configCandidates) {
              if (fs.existsSync(candidate)) {
                try {
                  const raw = JSON.parse(fs.readFileSync(candidate, "utf-8"));
                  sendJson(res, 200, raw);
                  return;
                } catch {
                  sendJson(res, 500, { error: "Failed to read config file" });
                  return;
                }
              }
            }
            sendJson(res, 200, { autoUpdate: false, outputLanguage: "en" });
            return;
          }

          const fileName =
            pathname === "/diff-overlay.json"
              ? "diff-overlay.json"
              : pathname === "/meta.json"
              ? "meta.json"
              : pathname === "/domain-graph.json"
              ? "domain-graph.json"
              : "knowledge-graph.json";

          const candidates = graphFileCandidates(fileName);

          for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) continue;

            // FIX 2 — sanitise absolute file paths before sending the JSON.
            // Nodes can contain filePath values like /Users/alice/company/src/auth.ts.
            // We convert those to relative paths (src/auth.ts) so the developer's
            // home directory and company directory layout are not leaked.
            try {
              const bytes = fs.readFileSync(candidate);
              const raw = JSON.parse(bytes.toString("utf8")) as {
                nodes?: Array<Record<string, unknown>>;
                [key: string]: unknown;
              };

              res.setHeader("Cache-Control", "no-store");
              if (fileName === "knowledge-graph.json") {
                res.setHeader("X-Understand-Graph-Hash", crypto.createHash("sha256").update(bytes).digest("hex"));
              }
              if (fileName === "diff-overlay.json") {
                const graphFile = findGraphFile("knowledge-graph.json");
                const graphHash = graphFile
                  ? crypto.createHash("sha256").update(fs.readFileSync(graphFile)).digest("hex") : null;
                if (!graphHash || raw.graphContentHash !== graphHash) {
                  sendJson(res, 409, { error: "Diff snapshot does not match the served knowledge graph. Regenerate /understand-diff." });
                  return;
                }
              }

              // Derive the project root from the candidate path so we can
              // make file paths relative to it.
              const projectRoot = projectRootFromGraphFile(candidate);

              if (Array.isArray(raw.nodes)) {
                raw.nodes = raw.nodes.map((node) => {
                  if (typeof node.filePath !== "string") return node;
                  const abs = node.filePath;
                  // Only relativise paths that actually sit inside projectRoot.
                  // Leave external or already-relative paths untouched.
                  const rel = abs.startsWith(projectRoot)
                    ? abs.slice(projectRoot.length).replace(/^[\\/]/, "")
                    : path.isAbsolute(abs)
                    ? path.basename(abs) // absolute but outside root — use filename only
                    : abs;              // already relative — keep as-is
                  return { ...node, filePath: rel };
                });
              }

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(raw));
            } catch (err) {
              // If we cannot parse or sanitise the file, refuse to serve it
              // rather than accidentally leaking raw content.
              console.error("[understand-anything] Failed to sanitise graph file:", err);
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Failed to read graph file" }));
            }
            return;
          }

          // No matching file found on disk.
          res.statusCode = 404;
          if (pathname === "/knowledge-graph.json") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "No knowledge graph found. Run /understand first." }));
          } else {
            res.end();
          }
        });
      },
    },
  ],
};

export default defineConfig(config);
