# gh-sync

Sync GitHub issues, PRs, releases, and CI workflow runs into [memory engine](https://memoryengine.build). Uses the `gh` CLI for all GitHub data — no tokens or API keys needed beyond `gh auth login`.

Each item becomes a searchable memory with metadata, temporal ranges, and formatted content.

## Prerequisites

- [GitHub CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)
- A running memory engine server with an API key

## Install

```bash
bun install          # or: npm install
```

## Usage

```bash
# Set auth
export ME_SERVER=http://localhost:3000
export ME_API_KEY=me_xxx

# Sync everything from a repo
bun gh-sync.ts --repo owner/repo

# Auto-detect repo from current git directory
bun gh-sync.ts

# Node/deno alternatives
npx tsx gh-sync.ts --repo owner/repo
deno run --allow-all gh-sync.ts --repo owner/repo
```

### Build a standalone binary

```bash
bun run build        # produces ./me-gh-sync
./me-gh-sync         # no runtime needed
```

## Options

```
--server <url>           Override ME_SERVER env var
--api-key <key>          Override ME_API_KEY env var
--repo <owner/repo>      GitHub repo (default: detect from git remote via gh)
--prefix <tree.path>     Tree prefix (default: auto-detect repo name, ltree-safe)
--sources <list>         Comma-separated: issues,prs,releases,ci (default: all)
--max <n>                Max items per source per run (default: 100)
--since <date>           Only items after this ISO date
--state <state>          Filter: open, closed, merged, all (default: all)
--depth <level>          summary | full (default: full)
--dry-run                Preview without creating memories
```

### Examples

```bash
# Only issues and PRs, max 50 each
bun gh-sync.ts --repo owner/repo --sources issues,prs --max 50

# Only open items since March
bun gh-sync.ts --repo owner/repo --state open --since 2026-03-01

# Preview what would be synced
bun gh-sync.ts --repo owner/repo --dry-run

# Summary depth (skip PR reviews and failed job details)
bun gh-sync.ts --repo owner/repo --depth summary
```

## How it works

1. **Validates** `gh auth status` and API key
2. **Detects repo** from `gh repo view` or `--repo` flag
3. **For each source** (issues, PRs, releases, CI runs):
   a. Finds the sync cursor (last synced timestamp per entity type)
   b. Fetches items from GitHub via `gh` CLI with incremental filtering
   c. Filters bots, empty items, and drafts
   d. Deduplicates against existing memories by number/tag/run_id
   e. Creates new memories in batches of 50, updates changed ones
   f. Advances the sync cursor

Re-running is cheap — only new or updated items since the cursor are processed.

## Sources

### Issues

Syncs GitHub issues with title, body, state, labels, and comments.

**Tree**: `{prefix}.github.issues`

**Comment condensation**: <=5 comments included verbatim. >5 comments: first, last, and author comments kept, rest condensed as `[... N comments condensed ...]`.

### Pull Requests

Same as issues plus review decision and reviewer details. At `--depth full`, fetches individual review comments per PR.

**Tree**: `{prefix}.github.prs`

### Releases

Release notes with tag, name, author, and pre-release flag. Drafts are skipped.

**Tree**: `{prefix}.github.releases`

### CI Runs (workflow runs)

Completed workflow runs with event, branch, conclusion, and duration. At `--depth full`, failed runs include job and step details.

**Tree**: `{prefix}.github.ci_runs`

## Memory format

### Meta conventions

All memories have:
```json
{
  "source": "github",
  "repo": "owner/repo",
  "entity_type": "issue|pr|release|ci_run",
  "author": "<login>"
}
```

Additional fields by type:
- Issues/PRs: `number`, `state`, `labels` (array)
- PRs: `review_decision`
- Releases: `tag`, `prerelease`
- CI runs: `run_id`, `workflow`, `conclusion`, `branch`, `event`

### Temporal mapping

| Entity | Start | End |
|--------|-------|-----|
| Open issue/PR | `createdAt` | — |
| Closed issue | `createdAt` | `closedAt` |
| Merged PR | `createdAt` | `mergedAt` |
| Release | `createdAt` | — |
| CI run | `createdAt` | `updatedAt` |

### Bot filtering

Authors matching these patterns are skipped: `[bot]$`, `dependabot`, `-bot$`, `github-actions`.

## Querying

```bash
# All GitHub content for a repo
me memory search --tree "myrepo.github.*"

# Issues by label
me memory search --meta '{"source":"github","entity_type":"issue","labels":["bug"]}'

# Semantic search across all GitHub content
me memory search --semantic "authentication" --meta '{"source":"github"}'

# Failed CI runs
me memory search --meta '{"source":"github","entity_type":"ci_run","conclusion":"failure"}'

# PRs merged last week
me memory search --meta '{"source":"github","entity_type":"pr","state":"merged"}' \
  --temporal '{"overlaps":["2026-03-01","2026-03-08"]}'
```

## Sync cursors

One cursor memory per entity type per repo is stored under `{prefix}.github._sync`. Cursors track the last synced timestamp and total imported count, enabling efficient incremental syncs.
