#!/usr/bin/env python3
"""
Merge script for Karpathy-pattern knowledge graphs.

Combines the deterministic scan-manifest.json with LLM analysis batches
(analysis-batch-*.json) into a final assembled knowledge graph.

Handles: entity deduplication, edge normalization, layer building from
index.md categories, tour generation from index.md section ordering.

Usage:
    python merge-knowledge-graph.py <wiki-directory>

Output:
    Writes assembled-graph.json to <wiki-directory>/<ua-dir>/intermediate/, where
    <ua-dir> is `.ua/` (or legacy `.understand-anything/` when that directory
    already exists).
"""

import argparse
import json
import runpy
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


# Load the sibling scanner without an installed package or bytecode cache.
_scan = runpy.run_path(str(Path(__file__).with_name("parse-knowledge-base.py")))
resolve_ua_dir = _scan["resolve_ua_dir"]
_find_markdown_case_insensitive = _scan["find_markdown_case_insensitive"]
source_snapshot = _scan["source_snapshot"]
source_state = _scan["source_state"]
atomic_json = _scan["atomic_json"]


def valid_provenance(value, base_nodes):
    """Evidence must point to an inventoried article and quote its supplied text.

    This verifies attribution, not the truth of a claim or the content of raw PDFs.
    """
    if not isinstance(value, list) or not value:
        return False
    for item in value:
        if not isinstance(item, dict):
            return False
        if not isinstance(item.get("articleId"), str):
            return False
        article = base_nodes.get(item["articleId"], {})
        quote = item.get("quote")
        if (article.get("type") != "article" or not isinstance(quote, str)
                or not quote.strip() or quote not in article.get("knowledgeMeta", {}).get("content", "")):
            return False
    return True


# ---------------------------------------------------------------------------
# Canonical type sets (must match core/src/types.ts)
# ---------------------------------------------------------------------------

VALID_NODE_TYPES = {
    "article", "entity", "topic", "claim", "source",
    # Codebase types (for cross-compatibility)
    "file", "function", "class", "module", "concept",
    "config", "document", "service", "table", "endpoint",
    "pipeline", "schema", "resource", "domain", "flow", "step",
}

VALID_EDGE_TYPES = {
    "cites", "contradicts", "builds_on", "exemplifies",
    "categorized_under", "authored_by", "related", "similar_to",
    # Codebase types
    "imports", "exports", "contains", "inherits", "implements",
    "calls", "subscribes", "publishes", "middleware",
    "reads_from", "writes_to", "transforms", "validates",
    "depends_on", "tested_by", "configures",
    "deploys", "serves", "provisions", "triggers",
    "migrates", "documents", "routes", "defines_schema",
    "contains_flow", "flow_step", "cross_domain",
}

NODE_TYPE_ALIASES = {
    "note": "article", "page": "article", "wiki_page": "article",
    "person": "entity", "actor": "entity", "organization": "entity",
    "tag": "topic", "category": "topic", "theme": "topic",
    "assertion": "claim", "decision": "claim", "thesis": "claim",
    "reference": "source", "raw": "source", "paper": "source",
}

EDGE_TYPE_ALIASES = {
    "references": "cites", "cites_source": "cites",
    "conflicts_with": "contradicts", "disagrees_with": "contradicts",
    "refines": "builds_on", "elaborates": "builds_on",
    "illustrates": "exemplifies", "instance_of": "exemplifies", "example_of": "exemplifies",
    "belongs_to": "categorized_under", "tagged_with": "categorized_under",
    "written_by": "authored_by", "created_by": "authored_by",
    "relates_to": "related", "related_to": "related",
}


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

def normalize_node_type(t: str) -> str:
    t = t.lower().strip()
    return NODE_TYPE_ALIASES.get(t, t)


def normalize_edge_type(t: str) -> str:
    t = t.lower().strip()
    return EDGE_TYPE_ALIASES.get(t, t)


def normalize_entity_name(name: str) -> str:
    """Normalize entity names for deduplication."""
    return re.sub(r'\s+', ' ', name.strip().lower())


# ---------------------------------------------------------------------------
# Merge pipeline
# ---------------------------------------------------------------------------

def merge(root: Path, save=False) -> dict:
    root = root.resolve()
    intermediate = resolve_ua_dir(root) / "intermediate"
    manifest_path = intermediate / "scan-manifest.json"

    if manifest_path.is_symlink():
        raise ValueError(f"Refusing symlink scan manifest: {manifest_path}")
    if not manifest_path.is_file():
        print(f"Error: {manifest_path} not found. Run parse-knowledge-base.py first.",
              file=sys.stderr)
        sys.exit(1)

    # Load scan manifest (deterministic base)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("sourceRoot") != str(root) or not manifest.get("scanId"):
        raise ValueError("Unbound scan manifest; rerun the parser for the selected source root")
    if source_snapshot(root) != manifest.get("inputFiles"):
        raise ValueError("Source changed since scan; rerun the parser and analysis")
    state = source_state(root, manifest["inputFiles"])
    if state["gitCommitHash"] != manifest.get("gitCommitHash"):
        raise ValueError("Source HEAD changed since scan; rerun the parser and analysis")
    nodes = {n["id"]: n for n in manifest["nodes"]}
    base_nodes = dict(nodes)
    edges = list(manifest["edges"])

    report = {"base_nodes": len(nodes), "base_edges": len(edges),
              "batches": 0, "new_entities": 0, "new_claims": 0,
              "new_edges": 0, "deduped_entities": 0, "dropped_edges": 0}

    # Load analysis batches
    batch_files = sorted(intermediate.glob("analysis-batch-*.json"))
    entity_name_map: dict[str, str] = {}  # normalized_name → entity_id
    dedup_remap: dict[str, str] = {}  # duplicate_id → canonical_id

    pending_edges = []
    for bf in batch_files:
        if bf.is_symlink():
            print(f"[merge] Warning: Skipping symlink batch {bf.name}", file=sys.stderr)
            continue
        try:
            batch = json.loads(bf.read_text(encoding="utf-8"))
            if not isinstance(batch, dict) or batch.get("scanId") != manifest["scanId"]:
                print(f"[merge] Warning: Skipping stale/unbound batch {bf.name}", file=sys.stderr)
                continue
            if not isinstance(batch.get("nodes", []), list) or not isinstance(batch.get("edges", []), list):
                raise ValueError("nodes and edges must be arrays")
        except (json.JSONDecodeError, OSError, ValueError) as error:
            print(f"[merge] Warning: Failed to load {bf.name}: {error}", file=sys.stderr)
            continue
        report["batches"] += 1
        for node in batch.get("nodes", []):
            if not isinstance(node, dict) or not isinstance(node.get("type"), str):
                continue
            node_type = normalize_node_type(node["type"])
            node_id = node.get("id")
            # Analysis may add inferred nodes, never replace the deterministic inventory.
            if (node_type not in ("entity", "claim") or not isinstance(node_id, str)
                    or not node_id.startswith(node_type + ":") or not node_id.split(":", 1)[1]
                    or node_id in base_nodes
                    or (node_type == "claim" and node_id in nodes)
                    or not isinstance(node.get("name"), str) or not node["name"].strip()
                    or not isinstance(node.get("summary", node.get("name")), str)
                    or not isinstance(node.get("tags", []), list)
                    or not all(isinstance(tag, str) for tag in node.get("tags", []))
                    or node.get("complexity", "simple") not in ("simple", "moderate", "complex")):
                print(f"[merge] Warning: Invalid or colliding analysis node {node_id!r}", file=sys.stderr)
                continue
            meta = node.get("knowledgeMeta", {})
            if not isinstance(meta, dict) or not valid_provenance(meta.get("provenance"), base_nodes):
                print(f"[merge] Warning: Missing/invalid article evidence for {node_id}", file=sys.stderr)
                continue
            if node_id in nodes and normalize_entity_name(node["name"]) != normalize_entity_name(nodes[node_id]["name"]):
                print(f"[merge] Warning: Conflicting entity ID {node_id}", file=sys.stderr)
                continue
            node["type"] = node_type
            if node_type == "entity":
                norm_name = normalize_entity_name(node["name"])
                if norm_name in entity_name_map:
                    canonical_id = entity_name_map[norm_name]
                    dedup_remap[node_id] = canonical_id
                    evidence = nodes[canonical_id]["knowledgeMeta"]["provenance"]
                    evidence.extend(item for item in meta["provenance"] if item not in evidence)
                    report["deduped_entities"] += 1
                    continue
                entity_name_map[norm_name] = node_id
                report["new_entities"] += 1
            else:
                report["new_claims"] += 1
            node.setdefault("summary", node["name"])
            node.setdefault("tags", [])
            node.setdefault("complexity", "simple")
            meta["extraction"] = "llm-inference"
            node["knowledgeMeta"] = meta
            nodes[node_id] = node
        pending_edges.extend(batch.get("edges", []))

    # Resolve after all batches: a forward reference must not depend on filename order.
    for edge in pending_edges:
        if not isinstance(edge, dict) or not isinstance(edge.get("type"), str):
            report["dropped_edges"] += 1
            continue
        meta = edge.get("knowledgeMeta", {})
        if not isinstance(meta, dict) or not valid_provenance(meta.get("provenance"), base_nodes):
            report["dropped_edges"] += 1
            continue
        edge_type = normalize_edge_type(edge["type"])
        if edge_type not in VALID_EDGE_TYPES:
            report["dropped_edges"] += 1
            continue
        if (not isinstance(edge.get("source"), str) or not isinstance(edge.get("target"), str)
                or edge.get("direction", "forward") not in ("forward", "backward", "bidirectional")
                or not isinstance(edge.get("weight", 0.5), (int, float))
                or isinstance(edge.get("weight"), bool) or not 0 <= edge.get("weight", 0.5) <= 1):
            report["dropped_edges"] += 1
            continue
        src = dedup_remap.get(edge.get("source", ""), edge.get("source", ""))
        tgt = dedup_remap.get(edge.get("target", ""), edge.get("target", ""))
        if src not in nodes or tgt not in nodes:
            report["dropped_edges"] += 1
            continue
        edge.update(source=src, target=tgt, type=edge_type)
        edge.setdefault("direction", "forward")
        edge.setdefault("weight", 0.5)
        meta["extraction"] = "llm-inference"
        evidence_text = "; ".join(f"{item['articleId']}: {item['quote']}" for item in meta["provenance"])
        edge["description"] = f"{edge.get('description', '')} [Article evidence: {evidence_text}]".strip()
        edges.append(edge)
        report["new_edges"] += 1

    # Deduplicate relationships while retaining each article's attribution.
    by_edge = {}
    for edge in edges:
        key = (edge["source"], edge["target"], edge["type"])
        if key not in by_edge:
            by_edge[key] = edge
            continue
        evidence = edge.get("knowledgeMeta", {}).get("provenance", [])
        if evidence:
            kept = by_edge[key].setdefault("knowledgeMeta", {}).setdefault("provenance", [])
            kept.extend(item for item in evidence if item not in kept)
            by_edge[key]["description"] = "Article evidence: " + "; ".join(
                f"{item['articleId']}: {item['quote']}" for item in kept)
    final_edges = list(by_edge.values())

    # --- Build article→layer map from categories ---
    categories = manifest.get("categories", [])
    article_layer_map: dict[str, str] = {}  # article_id → layer_id
    layer_members: dict[str, list[str]] = {}  # layer_id → [node_ids]

    for cat in categories:
        cat_name = cat["name"]
        cat_slug = cat_name.lower().replace(" ", "-")
        layer_id = f"layer:{cat_slug}"
        topic_id = f"topic:{cat_slug}"
        members = [e["source"] for e in final_edges
                   if e["type"] == "categorized_under" and e["target"] == topic_id]
        if topic_id in nodes:
            members.append(topic_id)
        layer_members[layer_id] = members
        for mid in members:
            article_layer_map[mid] = layer_id

    # Layer placement follows verified provenance, never filename/name guessing.
    for node_id, node in nodes.items():
        if node["type"] not in ("entity", "claim"):
            continue
        for item in node.get("knowledgeMeta", {}).get("provenance", []):
            layer_id = article_layer_map.get(item["articleId"])
            if layer_id in layer_members:
                layer_members[layer_id].append(node_id)

    # --- Build layers ---
    layers = []
    for cat in categories:
        cat_name = cat["name"]
        cat_slug = cat_name.lower().replace(" ", "-")
        layer_id = f"layer:{cat_slug}"
        members = list(dict.fromkeys(layer_members.get(layer_id, [])))  # Deduplicate preserving order
        layers.append({
            "id": layer_id,
            "name": cat_name,
            "description": f"{cat_name} ({len(members)} nodes)",
            "nodeIds": members,
        })

    # Assign uncategorized nodes to an "Other" layer
    categorized_ids = set()
    for layer in layers:
        categorized_ids.update(layer["nodeIds"])
    uncategorized = [nid for nid in nodes if nid not in categorized_ids]
    if uncategorized:
        layers.append({
            "id": "layer:other",
            "name": "Other",
            "description": f"Uncategorized nodes ({len(uncategorized)})",
            "nodeIds": uncategorized,
        })

    # --- Build tour from index.md category ordering ---
    tour = []
    for i, cat in enumerate(categories):
        cat_slug = cat["name"].lower().replace(" ", "-")
        topic_id = f"topic:{cat_slug}"
        # Pick representative articles (up to 3 per category)
        members = [e["source"] for e in final_edges
                   if e["type"] == "categorized_under" and e["target"] == topic_id][:3]
        if not members and topic_id in nodes:
            members = [topic_id]
        if members:
            tour.append({
                "order": i + 1,
                "title": cat["name"],
                "description": f"Explore the {cat['name']} section ({cat['count']} articles)",
                "nodeIds": members,
            })

    # --- Detect project name ---
    project_name = root.name
    # Try to find a better name from index.md H1 (case-insensitively —
    # Index.md is a reasonable convention; exact lowercase wins if both exist)
    index_path = _find_markdown_case_insensitive(root / "wiki", "index.md")
    if not index_path.is_file():
        index_path = _find_markdown_case_insensitive(root, "index.md")
    if index_path.is_file():
        text = index_path.read_text(encoding="utf-8", errors="replace")
        h1_match = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
        if h1_match:
            project_name = h1_match.group(1).strip()

    # --- Assemble final graph ---
    graph = {
        "version": "1.0.0",
        "kind": "knowledge",
        "project": {
            "name": project_name,
            "languages": ["markdown"],
            "frameworks": ["karpathy-wiki"],
            "description": f"Knowledge graph for {project_name}",
            "analyzedAt": datetime.now(timezone.utc).isoformat(),
            "gitCommitHash": manifest["gitCommitHash"],
            "sourceRoot": str(root),
            "workingTreeDirty": bool(manifest["workingTreeDirty"] or state["workingTreeDirty"]),
            "scanId": manifest["scanId"],
        },
        "nodes": list(nodes.values()),
        "edges": final_edges,
        "layers": layers,
        "tour": tour,
    }

    # Recheck immediately before publication; intermediate files and originals remain.
    final_state = source_state(root, manifest["inputFiles"])
    if (source_snapshot(root) != manifest["inputFiles"]
            or final_state["gitCommitHash"] != manifest["gitCommitHash"]):
        raise ValueError("Source changed during merge; rerun the scan and analysis")
    graph["project"]["workingTreeDirty"] |= final_state["workingTreeDirty"]
    out_path = intermediate / "assembled-graph.json"
    atomic_json(out_path, graph)
    if save:
        save_graph(root, graph)

    # Report
    print(f"[merge] Input: {report['base_nodes']} scan nodes, "
          f"{report['base_edges']} scan edges, {report['batches']} analysis batches",
          file=sys.stderr)
    print(f"[merge] Added: {report['new_entities']} entities, "
          f"{report['new_claims']} claims, {report['new_edges']} edges "
          f"({report['deduped_entities']} deduped entities, "
          f"{report['dropped_edges']} dropped dangling edges)", file=sys.stderr)
    print(f"[merge] Output: {len(graph['nodes'])} nodes, {len(final_edges)} edges, "
          f"{len(layers)} layers, {len(tour)} tour steps", file=sys.stderr)
    print(f"[merge] Written: {out_path}", file=sys.stderr)

    return graph


def save_graph(root, graph):
    ids = {node["id"] for node in graph["nodes"]}
    if len(ids) != len(graph["nodes"]):
        raise ValueError("Duplicate graph node IDs")
    for node in graph["nodes"]:
        if (not all(field in node for field in ("id", "type", "name", "summary", "tags", "complexity"))
                or not isinstance(node["tags"], list) or node["complexity"] not in ("simple", "moderate", "complex")):
            raise ValueError(f"Invalid graph node: {node.get('id')}")
    for edge in graph["edges"]:
        if edge["source"] not in ids or edge["target"] not in ids:
            raise ValueError("Dangling graph edge")
    ua_dir = resolve_ua_dir(root)
    meta = {key: graph["project"][key] for key in ("sourceRoot", "gitCommitHash", "workingTreeDirty", "scanId")}
    meta.update(lastAnalyzedAt=graph["project"]["analyzedAt"], version="1.0.0",
                analyzedFiles=sum(node["type"] == "article" for node in graph["nodes"]))
    # Preflight both destinations before replacing either.
    for name in ("knowledge-graph.json", "meta.json"):
        path = ua_dir / name
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError(f"Invalid generated output path: {path}")
    atomic_json(ua_dir / "knowledge-graph.json", graph)
    atomic_json(ua_dir / "meta.json", meta)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("wiki_directory", type=Path)
    cli.add_argument("--save", action="store_true", help="Validate and save graph + metadata; retain intermediates")
    args = cli.parse_args()
    root = args.wiki_directory.resolve()
    if not root.is_dir():
        cli.error(f"Not a directory: {root}")
    try:
        merge(root, save=args.save)
    except (OSError, ValueError, KeyError, TypeError) as error:
        cli.exit(1, f"[merge] {error}\n")

if __name__ == "__main__":
    main()
