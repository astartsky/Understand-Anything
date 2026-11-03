---
name: understand-dashboard
description: Launch or reopen the interactive Understand Anything dashboard for an existing codebase, knowledge, or domain graph. Not for generating or refreshing graphs, answering code questions, or building a general web dashboard.
argument-hint: "[project-path]"
---

# /understand-dashboard

Open an existing graph in the local dashboard. Accept `knowledge-graph.json`, `domain-graph.json`, or both. Generating or refreshing a graph belongs to `/understand`, `/understand-domain`, or `/understand-knowledge`.

## 1. Resolve and inspect the selected project

Set `SKILL_DIR` to the absolute directory containing this loaded `SKILL.md`, following its symlink. Treat the optional project argument as one literal path, defaulting to the current working directory. Run:

```bash
node "$SKILL_DIR/dashboard-context.mjs" -- "$PROJECT_ARG"
```

Set `PROJECT_ARG` to the supplied path or `.`. The read-only helper returns `projectRoot`, `uaDir`, graph paths, analysis dates/commits, and warnings. It needs only Node.js and optional Git; it does not load or install the analysis runtime.

- Keep the selected checkout as `PROJECT_ROOT`; never redirect to the Git common directory or another worktree.
- Use the existing `.understand-anything/` directory when present, otherwise `.ua/`. This is one directory choice for all data files, not a per-file fallback.
- If preflight fails, stop before launching or preparing dependencies. Missing graphs: suggest the appropriate generation command and name the searched directory.
- Show warnings about missing/mismatched source binding, commit differences, and dirty or unknown analysis state. Viewing may continue, but the graph does not prove current code. Do not refresh, copy, rename, or synthesize a graph to make the viewer start.

## 2. Locate the installed dashboard

Use the plugin runtime root supplied by the host, this skill's real parent plugin directory, or a known installation below. Use absolute paths from preflight for `PROJECT_ROOT`. Keep these variables in the same shell as the launch, or set them explicitly in that invocation; tool calls may use separate shells.

```bash
: "${SKILL_DIR:?Set the loaded skill directory}"
: "${PROJECT_ROOT:?Use projectRoot from preflight}"
SKILL_REAL=$(cd "$SKILL_DIR" && pwd -P) || exit 1
PLUGIN_ROOT=""
for candidate in \
  "${CLAUDE_PLUGIN_ROOT:-}" \
  "$SKILL_REAL/../.." \
  "$HOME/.understand-anything-plugin" \
  "$HOME/.codex/understand-anything/understand-anything-plugin" \
  "$HOME/.opencode/understand-anything/understand-anything-plugin" \
  "$HOME/.pi/understand-anything/understand-anything-plugin" \
  "$HOME/understand-anything/understand-anything-plugin"; do
  if [ -n "$candidate" ] && [ -f "$candidate/packages/dashboard/package.json" ]; then
    PLUGIN_ROOT=$(cd "$candidate" && pwd -P) || exit 1
    break
  fi
done
if [ -z "$PLUGIN_ROOT" ]; then
  echo "Dashboard runtime not found. Use a complete Understand Anything installation."
  exit 1
fi
DASHBOARD_DIR="$PLUGIN_ROOT/packages/dashboard"
```

## 3. Start an existing local runtime

Prefer the built standalone viewer: it does not need dependency installation or a core build to read a graph. Otherwise use the installed local Vite executable. Run this in a managed background terminal/session and retain its identity for stopping this process:

```bash
: "${PROJECT_ROOT:?Use projectRoot from preflight}"
: "${PLUGIN_ROOT:?Resolve the installed plugin root}"
DASHBOARD_DIR="$PLUGIN_ROOT/packages/dashboard"
VIEWER_DIR="$PLUGIN_ROOT/packages/viewer"
if [ -f "$VIEWER_DIR/bin/viewer.mjs" ] && \
   [ -f "$VIEWER_DIR/dist/index.html" ] && \
   [ -f "$VIEWER_DIR/bin/dist/staleness.js" ]; then
  node "$VIEWER_DIR/bin/viewer.mjs" "$PROJECT_ROOT" --no-open
else
  VITE_ENTRY="$DASHBOARD_DIR/node_modules/vite/bin/vite.js"
  if [ ! -f "$VITE_ENTRY" ] || [ ! -f "$PLUGIN_ROOT/packages/core/dist/schema.js" ]; then
    echo "Local viewer or dashboard dependencies/build are missing. No installation was run."
    exit 1
  fi
  cd "$DASHBOARD_DIR" || exit 1
  BROWSER=none GRAPH_DIR="$PROJECT_ROOT" node "$VITE_ENTRY" --host 127.0.0.1
fi
```

A startup failure is a failure: inspect its output instead of silently downloading executables or changing a lockfile. If setup is authorized under host policy, use the installation's documented pinned setup/build from its verified workspace root; otherwise report the missing prerequisite. Never run an install after a failed `cd`, relax `--frozen-lockfile`, or use a bare `npx vite` that may download a new version. Release viewers must match the installed plugin version; do not silently substitute a downloaded release for local fixes.

## 4. Verify and report the actual URL

Wait for this process to print:

```text
🔑  Dashboard URL: http://127.0.0.1:<PORT>/?token=<TOKEN>
```

Use the full printed URL, including the token. Ports can change when busy; never guess the port or token. Verify that an authenticated request for each selected graph returns JSON with the expected project, and that the browser renders the expected view when browser tooling is available. Domain-only data must open the domain view; an HTML page or a listening port alone is not proof. If startup exits or verification fails, report the actual error instead of “started”.

Open the verified URL using the host's browser tool when available. Report only the URL, selected graph path(s), relevant freshness warnings, and the retained terminal/session stop method. A detached background process has no usable Ctrl+C in the user's current terminal. Stop only the process/session started by this invocation; do not kill servers by name or port.

## Diff overlays are dated snapshots

The viewer accepts a diff overlay only when its SHA-256 fingerprint matches the raw served knowledge graph (before path sanitization), and its ID arrays refer to existing graph nodes. Missing/invalid identity, unknown IDs, duplicate/overlapping arrays, changed graphs, empty overlays and token/reload changes clear previous highlighting. A committed-only branch/PR snapshot may reference a head different from the selected checkout; this alone does not invalidate it.

The Diff control labels an accepted snapshot with `generatedAt` and `headCommitHash`. This binds it to the graph and records when it was produced; it does not prove that the current working tree still matches `workingTreeHash`. Regenerate `/understand-diff` to update a snapshot. Legacy overlays lacking fingerprints or snapshot metadata must be regenerated; never call them current.

## Validation after changes

Run `node --test "$SKILL_DIR/dashboard-context.test.mjs"`. Runtime changes also require the affected dashboard tests, viewer end-to-end tests, and a localhost domain-only consumer check. Keep synthetic graph fixtures and logs outside the project being viewed. Distinguish unit/API checks, an actual browser check, and manual routing traces in the result.
