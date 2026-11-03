import { beforeEach, describe, expect, it } from "vitest";
import { useDashboardStore } from "../store";
import { diffSnapshotLabel, graphResponseHash, validateDiffOverlay } from "../diff-overlay";
import type { KnowledgeGraph } from "@understand-anything/core/types";

const hash = "a".repeat(64);
const snapshot = { graphContentHash: hash, sourceRoot: "/snapshot/source", headCommitHash: "b".repeat(40), workingTreeHash: "c".repeat(64), generatedAt: "2026-11-03T12:00:00.000Z" };
function graph(): KnowledgeGraph {
  return { version: "1.0.0", project: { name: "Fixture", description: "", languages: [], frameworks: [], analyzedAt: "2026-11-03T12:00:00Z", gitCommitHash: "d".repeat(40) }, nodes: [{ id: "file:a", type: "file", name: "a", summary: "a", tags: [], complexity: "simple" }], edges: [], layers: [], tour: [] };
}
beforeEach(() => useDashboardStore.setState(useDashboardStore.getInitialState(), true));
describe("diff overlay lifecycle", () => {
  it("clears the previous overlay when a different graph is loaded", () => {
    useDashboardStore.getState().setGraph(graph(), hash);
    useDashboardStore.getState().setDiffOverlay(["file:a"], [], snapshot);
    useDashboardStore.getState().setGraph(graph(), "e".repeat(64));
    expect(useDashboardStore.getState().changedNodeIds.size).toBe(0);
    expect(useDashboardStore.getState().diffMode).toBe(false);
  });
  it("clears highlighting and diff mode when an empty overlay replaces a nonempty one", () => {
    useDashboardStore.getState().setGraph(graph(), hash);
    useDashboardStore.getState().setDiffOverlay(["file:a"], [], snapshot);
    useDashboardStore.getState().setDiffOverlay([], [], snapshot);
    expect(useDashboardStore.getState().changedNodeIds.size).toBe(0);
    expect(useDashboardStore.getState().diffMode).toBe(false);
  });
});


describe("diff snapshot validation", () => {
  const overlay = () => ({ ...snapshot, changedNodeIds: ["file:a"], affectedNodeIds: [] });
  it("accepts a PR snapshot head different from the loaded graph commit and labels its date/head", () => {
    const result = validateDiffOverlay(overlay(), hash, graph().nodes);
    expect(result).not.toBeNull();
    expect(diffSnapshotLabel(result!)).toBe("Snapshot 2026-11-03 12:00Z · bbbbbbbb");
  });
  it.each([
    { graphContentHash: "f".repeat(64) },
    { changedNodeIds: ["missing"] },
    { changedNodeIds: [42] },
    { changedNodeIds: ["file:a", "file:a"] },
    { affectedNodeIds: ["file:a"] },
    { generatedAt: "not a date" },
    { headCommitHash: "branch-name" },
    { workingTreeHash: "" },
    { sourceRoot: "" },
  ])("rejects a mismatched, malformed, unknown or overlapping snapshot %j", patch => {
    expect(validateDiffOverlay({ ...overlay(), ...patch }, hash, graph().nodes)).toBeNull();
  });
  it("fails closed when the loaded graph fingerprint is unavailable", () => {
    expect(validateDiffOverlay(overlay(), null, graph().nodes)).toBeNull();
  });
  it("clears an accepted overlay if a later response is bound to another graph", () => {
    const state = useDashboardStore.getState();
    state.setGraph(graph(), hash);
    state.setDiffOverlay(["file:a"], [], snapshot);
    state.setDiffOverlay(["file:a"], [], { ...snapshot, graphContentHash: "f".repeat(64) });
    expect(useDashboardStore.getState().diffSnapshot).toBeNull();
    expect(useDashboardStore.getState().diffMode).toBe(false);
  });
  it("clears overlay metadata on an explicit reload even when the graph hash is unchanged", () => {
    const state = useDashboardStore.getState();
    state.setGraph(graph(), hash);
    state.setDiffOverlay(["file:a"], [], snapshot);
    state.setGraph(graph(), hash);
    expect(useDashboardStore.getState().diffSnapshot).toBeNull();
    expect(useDashboardStore.getState().changedNodeIds.size).toBe(0);
  });
  it("uses the raw server fingerprint instead of hashing a sanitized graph body", async () => {
    const response = new Response("sanitized", { headers: { "X-Understand-Graph-Hash": hash } });
    expect(await graphResponseHash(response, await response.text())).toBe(hash);
  });
  it("hashes exact static-demo bytes when no server fingerprint exists", async () => {
    const response = new Response("abc");
    expect(await graphResponseHash(response, await response.text())).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
