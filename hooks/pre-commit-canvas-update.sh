#!/usr/bin/env bash
# pre-commit-canvas-update.sh
#
# Amendment 10 (truth-sync): if a commit touches source files that a canvas
# tile tracks, nudge the author to update the tile in the same commit.
#
# This is a WARNING, not a BLOCKER. We intentionally don't gate commits — if
# the author has a reason to not update the canvas, they get to proceed.
#
# How it works:
#  1. Build a { file_path → [node_id,...] } map by reading frontmatter from
#     _boards/nodes/**/*.md (each tile declares `tracks_paths: [...]`).
#  2. Look at staged files for the current commit.
#  3. If any staged file is tracked by a node AND the canvas file
#     (_boards/command-center.canvas) is NOT staged, print a warning with
#     the tile(s) that should probably be updated.
#
# Install:
#   ln -sf ../../tools/bench-cowork/hooks/pre-commit-canvas-update.sh \
#          .git/hooks/pre-commit
# (or chain from an existing pre-commit)

set -eo pipefail

# Resolve repo root
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${REPO_ROOT}" ]]; then
  exit 0
fi

BOARDS_DIR="${REPO_ROOT}/_boards"
# The canvas file may live in the Obsidian vault (outside the monorepo), so
# we also look at the local mirror if present.
CANVAS_FILE_MONO="${REPO_ROOT}/_boards/command-center.canvas"
CANVAS_FILE_VAULT="${HOME}/.openclaw/wiki/main/_boards/command-center.canvas"

# Skip silently if the boards directory isn't in the monorepo (some worktrees
# won't have it).
if [[ ! -d "${BOARDS_DIR}" ]]; then
  exit 0
fi

# Staged files (added/modified/copied/renamed, not deleted).
staged_files="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
if [[ -z "${staged_files}" ]]; then
  exit 0
fi

# Did this commit touch the canvas?
canvas_touched="no"
if echo "${staged_files}" | grep -qF "_boards/command-center.canvas"; then
  canvas_touched="yes"
fi

# Build the tracking map: for every nodes/*.md file, pull the `tracks_paths`
# frontmatter array. Emit one "path|node_id" line per tracked path.
#
# We tolerate the frontmatter being absent (older tiles pre-date Amendment 10
# and don't have tracks_paths). Those tiles simply contribute nothing to the
# map, so commits that touch their source code don't trigger any warning.
track_lines=""
if command -v awk >/dev/null 2>&1; then
  track_lines="$(
    find "${BOARDS_DIR}/nodes" -type f -name '*.md' 2>/dev/null | while read -r node_file; do
      awk -v f="${node_file}" '
        BEGIN { in_fm=0; in_tracks=0; id="" }
        /^---[[:space:]]*$/ {
          if (in_fm==0) { in_fm=1; next } else { exit }
        }
        in_fm==1 && /^node_id:[[:space:]]*/ {
          id=$0; sub(/^node_id:[[:space:]]*/, "", id); gsub(/[\"'\''[:space:]]/, "", id)
        }
        in_fm==1 && /^tracks_paths:[[:space:]]*\[/ {
          line=$0
          sub(/^tracks_paths:[[:space:]]*\[/, "", line)
          sub(/\][[:space:]]*$/, "", line)
          n=split(line, arr, ",")
          for (i=1; i<=n; i++) {
            path=arr[i]
            gsub(/^[[:space:]"'\'']+|[[:space:]"'\'']+$/, "", path)
            if (path != "" && id != "") print path "|" id
          }
        }
      ' "${node_file}"
    done
  )"
fi

if [[ -z "${track_lines}" ]]; then
  # No tile declares tracks_paths yet. Nothing to check.
  exit 0
fi

# For each staged file, see if any tracked path is a prefix.
warnings=""
while IFS= read -r staged; do
  [[ -z "${staged}" ]] && continue
  while IFS='|' read -r tracked_path node_id; do
    [[ -z "${tracked_path}" || -z "${node_id}" ]] && continue
    # Glob-style match: if tracked path ends with `/**` or `/*`, treat as prefix.
    prefix="${tracked_path%/**}"
    prefix="${prefix%/*}"
    if [[ "${staged}" == "${tracked_path}" ]] || [[ "${staged}" == "${prefix}"/* ]]; then
      warnings+="${staged} → tile ${node_id}"$'\n'
    fi
  done <<< "${track_lines}"
done <<< "${staged_files}"

if [[ -z "${warnings}" ]]; then
  exit 0
fi

# Deduplicate.
warnings="$(echo "${warnings}" | sort -u)"

if [[ "${canvas_touched}" == "yes" ]]; then
  # Author already staged the canvas — Amendment 10 satisfied.
  exit 0
fi

# Not a blocker; just warn and let the commit through.
cat >&2 <<EOF
────────────────────────────────────────────────────────────
⚠ Amendment 10 nudge: this commit touches source files tracked
  by a canvas tile, but you haven't staged the canvas update.

Affected:
${warnings}
  Canvas: _boards/command-center.canvas (not staged)
  Vault:  ${CANVAS_FILE_VAULT}

If the tile should reflect this change, update it via:
  ~/.openclaw/scripts/canvas-set-node-text.sh <node_id> "<new text>"

Or dismiss this nudge by committing anyway (Amendment 10 is guidance,
not a gate).
────────────────────────────────────────────────────────────
EOF

exit 0
