# Validate and save

Read for full analysis or explicit `--review`. Incremental default saves use the deterministic finalizer in [architecture-and-tour.md](architecture-and-tour.md).

## Phase 6 — REVIEW

Report to the user: `[Phase 6/7] Validating knowledge graph...`

For incremental `--review`, the save gate already copied a complete KnowledgeGraph to `assembled-graph.json`. Do not reconstruct it from node/edge-only merge output; skip directly to the `--review` graph-reviewer path below. The default deterministic path is for full analysis only.

Assemble the full KnowledgeGraph JSON object:

```json
{
  "version": "1.0.0",
  "project": {
    "name": "<projectName>",
    "languages": ["<languages>"],
    "frameworks": ["<frameworks>"],
    "description": "<projectDescription>",
    "analyzedAt": "<ISO 8601 timestamp>",
    "gitCommitHash": "<commit hash from Phase 0>"
  },
  "nodes": [<all nodes from assembled-graph.json after Phase 3 review>],
  "edges": [<all edges from assembled-graph.json after Phase 3 review>],
  "layers": [<layers from Phase 4>],
  "tour": [<steps from Phase 5>]
}
```

1. Before writing the assembled graph, validate that:
   - `layers` is an array of objects with these required fields: `id`, `name`, `description`, `nodeIds`
   - `tour` is an array of objects with these required fields: `order`, `title`, `description`, `nodeIds`
   - `tour[*].languageLesson` is allowed as an optional string field
   - Every `layers[*].nodeIds` entry exists in the merged node set
   - Every `tour[*].nodeIds` entry exists in the merged node set

   If validation fails, automatically normalize and rewrite the graph into this shape before saving. If the graph still fails final validation after the normalization pass, keep it under `intermediate/` with diagnostics; do not replace a valid published local graph or advance metadata.

2. Write the assembled graph to `$UA_DIR/intermediate/assembled-graph.json`.

3. **Check `$ARGUMENTS` for `--review` flag.** Then run the appropriate validation path:

---

#### Default path (no `--review`): bundled deterministic validation

Run the bundled deterministic validator:

```bash
node "<SKILL_DIR>/validate-graph.cjs" \
  "$UA_DIR/intermediate/assembled-graph.json" \
  "$UA_DIR/intermediate/review.json"
```

A non-zero exit is a failed check: read stderr and correct the input or runtime cause. Do not reuse an older `review.json`. Exit 0 means a report was written; inspect `issues` before treating the graph as valid.

---

#### `--review` path: full LLM reviewer

If `--review` IS in `$ARGUMENTS`, dispatch the LLM graph-reviewer subagent as follows:

Dispatch a subagent using the `graph-reviewer` agent definition (at `agents/graph-reviewer.md`). Append the following additional context:

> **Additional context from main session:**
>
> Phase 1 scan results (file inventory):
> ```json
> [list of {path, sizeLines} from scan-result.json]
> ```
>
> Phase warnings/errors accumulated during analysis:
> - [list any batch failures, skipped files, or warnings from Phases 2-5]
>
> Cross-validate: every file in the scan inventory should have a corresponding node in the graph (node types may vary: `file:`, `config:`, `document:`, `service:`, `pipeline:`, `table:`, `schema:`, `resource:`, `endpoint:`). Flag any missing files. Also flag any graph nodes whose `filePath` doesn't appear in the scan inventory.

Pass these parameters in the dispatch prompt:

> Validate the knowledge graph at `$UA_DIR/intermediate/assembled-graph.json`.
> Project root: `$PROJECT_ROOT`
> Read the file and validate it for completeness and correctness.
> Write output to: `$UA_DIR/intermediate/review.json`

---

4. Read `$UA_DIR/intermediate/review.json`.

5. **If `issues` array is non-empty:**
   - Review the `issues` list
   - Apply automated fixes where possible:
     - Remove edges with dangling references
     - Fill missing required fields with sensible defaults (e.g., empty `tags` -> `["untagged"]`, empty `summary` -> `"No summary available"`)
     - Remove nodes with invalid types
   - Re-run the final graph validation after automated fixes
   - If critical issues remain after one fix attempt, retain the candidate in `intermediate/`, report unresolved issues, and stop without advancing the saved graph or metadata

6. **If `issues` array is empty:** Proceed to Phase 7.

---

## Phase 7 — SAVE

Report to the user: `[Phase 7/7] Saving knowledge graph...`

1. Retain the final validated candidate at `$UA_DIR/intermediate/assembled-graph.json`. Save it as `$UA_DIR/knowledge-graph.json` only after the fingerprint step below succeeds. Do not overwrite a previous graph with a failed candidate.

2. **Generate structural fingerprints baseline.** This creates the basis for future automatic incremental updates and **must succeed before `meta.json` is written** — otherwise auto-update sees a fresh commit hash with no fingerprints to compare against, classifies every file as STRUCTURAL, and escalates to `FULL_UPDATE` on every subsequent commit (issue #152).

   Write the input file:
   ```bash
   node - "$PROJECT_ROOT" "$UA_DIR/intermediate/fingerprint-input.json" <<'NODE'
   const fs = require('fs');
   const projectRoot = process.argv[2];
   const outputPath = process.argv[3];
   const input = {
     projectRoot,
     filePaths: [<all analyzed file paths from Phase 1, including non-code files, as JSON array>],
     gitCommitHash: "<current commit hash>",
   };
   fs.writeFileSync(outputPath, JSON.stringify(input, null, 2));
   NODE
   ```

   Then invoke the bundled script (under `<SKILL_DIR>`):
   ```bash
   node "<SKILL_DIR>/build-fingerprints.mjs" \
     "$UA_DIR/intermediate/fingerprint-input.json"
   ```

   The script uses `TreeSitterPlugin + PluginRegistry` exactly like `extract-structure.mjs`, so the baseline matches incremental comparison. The baseline MUST include every file in `scan-result.json`, not only source-code files; unsupported formats receive conservative content-only fingerprints.

   **If the script exits non-zero or stdout does not include `Fingerprints baseline:`, abort Phase 7 and report the error. Do NOT proceed to step 3 (writing `meta.json`).**

   After a successful baseline, copy the validated candidate to `$UA_DIR/knowledge-graph.json`.

3. **Bind metadata to the analyzed source.** Use the exact preflight snapshot saved before scanning:

   ```bash
   node "<SKILL_DIR>/analysis-context.mjs" save-meta "$UA_DIR/tmp/context.json"
   ```

   This checks the selected source HEAD is unchanged and the saved graph/fingerprints share that commit, then atomically writes `meta.json` with `sourceRoot`, `gitBranch`, `workingTreeDirty`, file count, and commit. A failure stops completion and dashboard launch; retain diagnostics. For non-Git projects the hash is empty and the result is explicitly a working snapshot, never a reproducible commit baseline.

4. Keep `intermediate/scan-result.json` for incremental reconciliation. Other generated scratch files may be cleaned only within host policy. Do not automatically purge old directories or rename them to bypass a deletion approval. Leaving diagnostic intermediates does not invalidate a successful graph.

5. Report a summary to the user containing:
   - Project name and description
   - Files analyzed / total files (with breakdown by fileCategory: code, config, docs, infra, data, script, markup)
   - Nodes created (broken down by type: file, function, class, config, document, service, table, endpoint, pipeline, schema, resource)
   - Edges created (broken down by type)
   - Layers identified (with names)
   - Tour steps generated (count)
   - Any warnings from the reviewer
   - Path to the output file: `$UA_DIR/knowledge-graph.json`

6. Only automatically launch the dashboard by invoking the `/understand-dashboard` skill if final graph validation passed after normalization/review fixes.
   Pass the selected `$SOURCE_ROOT` explicitly to the dashboard. If final validation did not pass, report the retained candidate and skipped dashboard launch.
