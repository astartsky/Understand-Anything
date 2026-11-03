# Baseline reuse and incremental preparation

Read after the entrypoint resolves source, runtime, and data directory. `$LAST_COMMIT_HASH` comes from `lastCommitHash` in the context JSON, never shell cwd.

## Baseline decision

The entrypoint `analysis-context.mjs` result is the gate. If `baselineAction` is `FULL`, run all phases regardless of matching commit strings or `--review`; report `fullReason`. Never review or incrementally reuse a graph from another source checkout. Missing legacy `sourceRoot` requires one full rebuild.

If the source-bound baseline is valid:

| Condition | Action |
|---|---|
| Explicit `--exclude` | Reconcile inventory even at unchanged HEAD |
| `CURRENT` + `--review` | Review-only path below |
| `CURRENT` | Report the existing graph and selected source as current, then STOP |
| `INCREMENTAL` | Run deterministic preparation below |

If the user explicitly asks to merge subdomain graphs, use `python3 "<SKILL_DIR>/merge-subdomain-graphs.py" "$PROJECT_ROOT"` only for graphs verified against this source/revision. Do not automatically merge unknown or stale subdomain artifacts into a fresh build.

   **Review-only path:** Copy the existing `knowledge-graph.json` to `$UA_DIR/intermediate/assembled-graph.json`, then jump directly to Phase 6 step 3.

   For incremental updates, do **not** construct the changed-file list by hand. Run the bundled reconciliation helper with the previous analyzed commit. Pass `--exclude "$EXCLUDE_PATTERNS"` only when the option is non-empty:
   ```bash
   node "<SKILL_DIR>/prepare-incremental.mjs" \
     "$PROJECT_ROOT" \
     "$LAST_COMMIT_HASH"
   ```

   With explicit exclusions:
   ```bash
   node "<SKILL_DIR>/prepare-incremental.mjs" \
     "$PROJECT_ROOT" \
     "$LAST_COMMIT_HASH" \
     --exclude "$EXCLUDE_PATTERNS"
   ```

   The helper uses parameterized `git diff --name-status -z`, performs a fresh deterministic scan with the current `.understandignore` / `--exclude` rules, compares structural fingerprints, selectively refreshes imports, and atomically writes:
   - `$UA_DIR/intermediate/incremental-plan.json`
   - `$UA_DIR/intermediate/scan-result.json`
   - `$UA_DIR/intermediate/changed-files.json`
   - `$UA_DIR/intermediate/batch-existing.json` for partial/architecture updates
   - `$UA_DIR/intermediate/incremental-symbol-baseline.json`, the previous node inventory for reanalyzed files, bound to the base/head commits

   Read `incremental-plan.json` and store its `action`, `filesToReanalyze`, `deletedFiles`, `rerunArchitecture`, and `rerunTour` values. Follow this gate:

   | Prepared action | Next step |
   |---|---|
   | `SKIP` | Run `node "<SKILL_DIR>/finalize-incremental.mjs" "$PROJECT_ROOT"`. It updates graph metadata, scan, fingerprints, and meta for cosmetic or irrelevant changes, but intentionally advances nothing for generated-artifact-only commits. Without `--review`, report that no analyzer or reviewer agent ran and **STOP**. With explicit `--review`, copy `$UA_DIR/knowledge-graph.json` to `$UA_DIR/intermediate/assembled-graph.json` and jump to the `--review` graph-reviewer path in Phase 6 instead of stopping. |
   | `PARTIAL_UPDATE` | Skip Phase 0.5 and Phase 1; continue with the incremental Phase 1.5/2 path. |
   | `ARCHITECTURE_UPDATE` | Skip Phase 0.5 and Phase 1; continue with incremental analysis, then rerun Phase 4 and Phase 5. |
   | `FULL_UPDATE` | Switch to the existing full pipeline beginning at Phase 0.5. Do not patch fingerprints or metadata from the incremental helper. |

   `filesToReanalyze` contains only current, non-ignored files with structural changes. Deletions, newly ignored files, cosmetic changes, and generated artifacts are never passed to file-analyzer.

## Collect project context
   - Read `README.md` (or `README.rst`, `readme.md`) from `$PROJECT_ROOT` if it exists. Store as `$README_CONTENT` (first 3000 characters).
   - Read the primary package manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`) if it exists. Store as `$MANIFEST_CONTENT`.
   - Capture the top-level directory tree:
     ```bash
     find "$PROJECT_ROOT" -maxdepth 2 -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -100
     ```
     Store as `$DIR_TREE`.
   - Detect the project entry point by checking for common patterns (in order): `src/index.ts`, `src/main.ts`, `src/App.tsx`, `index.js`, `main.py`, `manage.py`, `app.py`, `wsgi.py`, `asgi.py`, `run.py`, `__main__.py`, `main.go`, `cmd/*/main.go`, `src/main.rs`, `src/lib.rs`, `src/main/java/**/Application.java`, `Program.cs`, `config.ru`, `index.php`. Store first match as `$ENTRY_POINT`.
