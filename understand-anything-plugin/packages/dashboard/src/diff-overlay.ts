export interface DiffSnapshot {
  graphContentHash: string;
  sourceRoot: string;
  headCommitHash: string;
  workingTreeHash: string;
  generatedAt: string;
}

export interface DiffOverlay extends DiffSnapshot {
  changedNodeIds: string[];
  affectedNodeIds: string[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Bind a dated snapshot to the exact loaded graph, not to the current worktree. */
export function validateDiffOverlay(
  value: unknown,
  graphContentHash: string | null,
  nodes: ReadonlyArray<{ id: string }>,
): DiffOverlay | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (!graphContentHash || !SHA256.test(graphContentHash) || data.graphContentHash !== graphContentHash) return null;
  if (typeof data.sourceRoot !== "string" || !data.sourceRoot.trim()) return null;
  if (typeof data.headCommitHash !== "string" || !COMMIT.test(data.headCommitHash)) return null;
  if (typeof data.workingTreeHash !== "string" || !SHA256.test(data.workingTreeHash)) return null;
  if (typeof data.generatedAt !== "string" || !Number.isFinite(Date.parse(data.generatedAt))) return null;
  const knownIds = new Set(nodes.map(node => node.id));
  const validIds = (ids: unknown): ids is string[] => Array.isArray(ids)
    && ids.every(id => typeof id === "string" && knownIds.has(id))
    && new Set(ids).size === ids.length;
  if (!validIds(data.changedNodeIds) || !validIds(data.affectedNodeIds)) return null;
  const changed = new Set(data.changedNodeIds);
  if (data.affectedNodeIds.some(id => changed.has(id))) return null;
  return data as unknown as DiffOverlay;
}

/** Servers provide a pre-sanitization hash; static demos can hash their raw body. */
export async function graphResponseHash(response: Response, body: string): Promise<string | null> {
  const serverHash = response.headers.get("X-Understand-Graph-Hash");
  if (serverHash && SHA256.test(serverHash)) return serverHash;
  if (!globalThis.crypto?.subtle) return null;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function diffSnapshotLabel(snapshot: DiffSnapshot): string {
  const date = new Date(snapshot.generatedAt).toISOString().slice(0, 16).replace("T", " ");
  return `Snapshot ${date}Z · ${snapshot.headCommitHash.slice(0, 8)}`;
}
