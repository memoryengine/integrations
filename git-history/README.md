# git-history

Backfill and incrementally sync git commits into [memory engine](https://memoryengine.build). Run from inside any git repo using bun, node, or deno.

Each commit becomes a searchable memory with metadata (SHA, author, date, branch) and temporal information for time-range queries.

## Install

```bash
bun install          # or: npm install
```

## Usage

```bash
# Set auth
export ME_SERVER=http://localhost:3000
export ME_API_KEY=me_xxx

# Run from inside a git repo
bun git-history.ts              # backfill + incremental sync
npx tsx git-history.ts          # node alternative
deno run --allow-all git-history.ts  # deno alternative
```

### Build a standalone binary

```bash
bun run build        # produces ./me-git-history
./me-git-history     # no runtime needed
```

## Options

```
--server <url>           Override ME_SERVER env var
--api-key <key>          Override ME_API_KEY env var
--repo <name>            Override auto-detected repo name (ltree-safe)
--prefix <tree.path>     Tree prefix before <repo>.git_history
--depth metadata|files   Content depth (default: files)
--since <date>           Only commits after this ISO date
--after <sha>            Only commits after this SHA
--max <n>                Max commits to process
--branch <name>          Branch to log (default: current HEAD)
--dry-run                Preview without creating memories
```

## How it works

1. **Detects the repo name** from `git remote get-url origin` (falls back to directory name)
2. **Checks for a sync cursor** — a special memory that tracks the last imported commit
3. **Fetches new commits** via `git log`, using `<last_sha>..HEAD` for incremental runs
4. **Filters out** merge commits and empty subjects
5. **Creates memories** in batches of 50 via `memory.batchCreate()`
6. **Updates the sync cursor** after all batches succeed

Re-running is cheap — only new commits since the cursor are processed.

## Memory format

Each commit is stored as a memory with this structure:

**Tree**: `[prefix.]<repo>.git_history`

**Meta**:
```json
{
  "source": "git",
  "repo": "my_repo",
  "commit": "a1b2c3d4...",
  "author": "dev@example.com",
  "branch": "refs/heads/main"
}
```

**Temporal**: `{ "start": "<commit date ISO>" }`

**Content** (at `files` depth):
```markdown
# Add rate limiting middleware

**Commit**: a1b2c3d
**Author**: dev@example.com
**Date**: 2026-02-15T10:30:00Z

## Files Changed
- A	src/middleware/rate-limit.ts
- M	src/server/routes.ts
```

## Querying

```bash
# All commits in a repo
me memory search --meta '{"source":"git","repo":"my_repo"}'

# Commits by author
me memory search --meta '{"source":"git","author":"dev@example.com"}'

# Semantic search
me memory search --semantic "rate limiting" --meta '{"source":"git"}'

# What changed last week
me memory search --meta '{"source":"git"}' --temporal '{"overlaps":["2026-03-01","2026-03-08"]}'
```
