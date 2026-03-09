#!/usr/bin/env -S npx tsx
/**
 * git-history — Backfill and incrementally sync git commits into memory engine.
 *
 * Usage:
 *   ME_SERVER=http://localhost:3000 ME_API_KEY=me_xxx bun git-history.ts
 *   ME_SERVER=http://localhost:3000 ME_API_KEY=me_xxx npx tsx git-history.ts
 *   ME_SERVER=http://localhost:3000 ME_API_KEY=me_xxx deno run --allow-all git-history.ts
 */

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { createClient, type MeClient } from "@memoryengine/client";

// ===== Types =====

type Depth = "metadata" | "files";

interface Options {
  server: string;
  apiKey: string;
  repo: string;
  prefix?: string;
  depth: Depth;
  since?: string;
  after?: string;
  max?: number;
  branch?: string;
  dryRun: boolean;
}

interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

// ===== Git Helpers =====

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }).trim();
}

function isInsideWorkTree(): boolean {
  try {
    return git("rev-parse", "--is-inside-work-tree") === "true";
  } catch {
    return false;
  }
}

function detectRepoName(): string {
  try {
    const url = git("remote", "get-url", "origin");
    // git@github.com:org/repo.git or https://github.com/org/repo.git
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (match?.[1]) return makeLtreeSafe(match[1]);
  } catch {
    // no remote
  }
  return makeLtreeSafe(basename(process.cwd()));
}

function makeLtreeSafe(name: string): string {
  return name.toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]/g, "");
}

function currentBranch(): string {
  try {
    return git("symbolic-ref", "HEAD");
  } catch {
    // detached HEAD
    return git("rev-parse", "--short", "HEAD");
  }
}

function shaExists(sha: string): boolean {
  try {
    git("cat-file", "-t", sha);
    return true;
  } catch {
    return false;
  }
}

// ===== Commit Fetching =====

const IGNORE_PATTERNS = [/^Merge branch\b/, /^Merge pull request\b/, /^Merge remote-tracking\b/];

function fetchCommits(opts: Options, range?: string): Commit[] {
  const args = ["log", "--format=%H%x00%ae%x00%aI%x00%s", "--reverse"];

  if (range) {
    args.push(range);
  }

  if (opts.since) {
    args.push(`--after=${opts.since}`);
  }
  if (opts.max) {
    args.push(`-n`, String(opts.max));
  }
  if (opts.branch && !range) {
    args.push(opts.branch);
  }

  let output: string;
  try {
    output = git(...args);
  } catch {
    return [];
  }
  if (!output) return [];

  return output.split("\n").map((line) => {
    const parts = line.split("\0");
    return {
      sha: parts[0] ?? "",
      author: parts[1] ?? "",
      date: parts[2] ?? "",
      subject: parts.slice(3).join("\0"),
    };
  });
}

function getChangedFiles(sha: string): string[] {
  try {
    const output = git("diff-tree", "--no-commit-id", "--name-status", "-r", sha);
    return output ? output.split("\n") : [];
  } catch {
    return [];
  }
}

function getCommitBody(sha: string): string {
  try {
    return git("log", "-1", "--format=%b", sha);
  } catch {
    return "";
  }
}

// ===== Content Formatting =====

function formatContent(commit: Commit, body: string, files: string[], depth: Depth): string {
  const short = commit.sha.slice(0, 7);
  let content = `# ${commit.subject}\n\n`;
  content += `**Commit**: ${short}\n`;
  content += `**Author**: ${commit.author}\n`;
  content += `**Date**: ${commit.date}\n`;

  if (body) {
    content += `\n${body}\n`;
  }

  if (depth === "files" && files.length > 0) {
    content += "\n## Files Changed\n";
    for (const f of files) {
      content += `- ${f}\n`;
    }
  }

  return content;
}

// ===== CLI Argument Parsing =====

function parseArgs(): Partial<Options> {
  const args = process.argv.slice(2);
  const opts: Partial<Options> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server":
        opts.server = args[++i];
        break;
      case "--api-key":
        opts.apiKey = args[++i];
        break;
      case "--repo":
        opts.repo = args[++i];
        break;
      case "--prefix":
        opts.prefix = args[++i];
        break;
      case "--depth":
        opts.depth = args[++i] as Depth;
        break;
      case "--since":
        opts.since = args[++i];
        break;
      case "--after":
        opts.after = args[++i];
        break;
      case "--max":
        opts.max = parseInt(args[++i] ?? "0", 10);
        break;
      case "--branch":
        opts.branch = args[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
    }
  }

  return opts;
}

function printUsage(): void {
  console.log(`Usage: git-history.ts [options]

Auth (env vars or flags):
  ME_SERVER=<url>          Server URL (default: http://localhost:3000)
  ME_API_KEY=<key>         API key for authentication

Options:
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
  -h, --help               Show this help`);
}

// ===== Sync Cursor =====

interface CursorMemory {
  id: string;
  meta: Record<string, unknown>;
}

async function findCursor(client: MeClient, repo: string): Promise<CursorMemory | null> {
  const result = await client.memory.search({
    meta: { source: "git", repo, type: "sync_cursor" },
    limit: 1,
  });
  const m = result.results[0];
  if (m) {
    return { id: m.id, meta: m.meta };
  }
  return null;
}

async function upsertCursor(
  client: MeClient,
  cursor: CursorMemory | null,
  repo: string,
  treePath: string,
  lastSha: string,
  lastDate: string,
  totalImported: number,
): Promise<void> {
  const meta = {
    source: "git",
    repo,
    type: "sync_cursor",
    last_commit: lastSha,
    last_date: lastDate,
    total_imported: totalImported,
  };
  const content = `Sync cursor for ${repo}. Last: ${lastSha.slice(0, 7)} (${lastDate}). Total: ${totalImported} commits.`;

  if (cursor) {
    await client.memory.update({ id: cursor.id, content, meta });
  } else {
    await client.memory.create({ content, tree: treePath, meta });
  }
}

// ===== Main =====

async function main(): Promise<void> {
  // 1. Parse args + env vars
  const cliOpts = parseArgs();

  const server = cliOpts.server ?? process.env.ME_SERVER ?? "";
  const apiKey = cliOpts.apiKey ?? process.env.ME_API_KEY ?? "";

  if (!server) {
    console.error("Error: ME_SERVER not set. Use --server <url> or set ME_SERVER env var.");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("Error: ME_API_KEY not set. Use --api-key <key> or set ME_API_KEY env var.");
    process.exit(1);
  }

  // Validate git repo
  if (!isInsideWorkTree()) {
    console.error("Error: not inside a git repository.");
    process.exit(1);
  }

  const client = createClient({ server, apiKey });

  // 2. Detect repo name
  const repo = cliOpts.repo ? makeLtreeSafe(cliOpts.repo) : detectRepoName();

  // 3. Build tree path
  const treePath = cliOpts.prefix ? `${cliOpts.prefix}.${repo}.git_history` : `${repo}.git_history`;

  const depth: Depth = cliOpts.depth ?? "files";
  const branchRef = cliOpts.branch ?? currentBranch();

  console.log(`Repo: ${repo} | Tree: ${treePath} | Depth: ${depth} | Branch: ${branchRef}`);

  // 4. Incremental check — sync cursor
  const cursor = await findCursor(client, repo);
  let range: string | undefined;
  let previousTotal = 0;
  let sinceDate = cliOpts.since;

  if (cursor) {
    const lastSha = cursor.meta.last_commit as string;
    const lastDate = cursor.meta.last_date as string;
    previousTotal = (cursor.meta.total_imported as number) ?? 0;
    console.log(`Cursor found: last commit ${lastSha.slice(0, 7)} (${lastDate}), ${previousTotal} imported`);

    if (shaExists(lastSha)) {
      range = `${lastSha}..HEAD`;
    } else {
      console.log(`Warning: cursor SHA ${lastSha.slice(0, 7)} not found in repo, using date fallback`);
      if (!sinceDate) {
        sinceDate = lastDate;
      }
    }
  } else {
    console.log("No cursor found — full backfill mode");
  }

  // --after flag overrides cursor range
  if (cliOpts.after) {
    if (shaExists(cliOpts.after)) {
      range = `${cliOpts.after}..HEAD`;
    } else {
      console.error(`Error: --after SHA ${cliOpts.after} not found in repo.`);
      process.exit(1);
    }
  }

  // 5. Fetch commits from git
  const opts: Options = {
    server,
    apiKey,
    repo,
    prefix: cliOpts.prefix,
    depth,
    since: sinceDate,
    after: cliOpts.after,
    max: cliOpts.max,
    branch: cliOpts.branch,
    dryRun: cliOpts.dryRun ?? false,
  };

  const allCommits = fetchCommits(opts, range);
  console.log(`Found ${allCommits.length} commits from git log`);

  // 6. Filter commits
  const commits = allCommits.filter((c) => {
    if (IGNORE_PATTERNS.some((p) => p.test(c.subject))) return false;
    if (!c.subject.trim()) return false;
    return true;
  });

  const filtered = allCommits.length - commits.length;
  if (filtered > 0) {
    console.log(`Filtered out ${filtered} merge/empty commits`);
  }

  if (commits.length === 0) {
    console.log("Done: 0 created, 0 skipped, 0 errors");
    return;
  }

  // Dedup against existing imports when cursor SHA was not found (date fallback)
  let deduped = 0;
  let commitsToProcess = commits;
  if (cursor && !range) {
    // Need to dedup — search for recent imports and exclude already-imported SHAs
    const recentResult = await client.memory.search({
      meta: { source: "git", repo },
      limit: 200,
      order_by: "desc",
    });
    const existingShas = new Set(recentResult.results.map((r) => r.meta.commit as string));
    commitsToProcess = commits.filter((c) => {
      if (existingShas.has(c.sha)) {
        deduped++;
        return false;
      }
      return true;
    });
    if (deduped > 0) {
      console.log(`Deduped ${deduped} already-imported commits`);
    }
  }

  if (commitsToProcess.length === 0) {
    console.log("Done: 0 created, 0 skipped, 0 errors");
    return;
  }

  // Dry run
  if (opts.dryRun) {
    console.log(`\nDry run — would create ${commitsToProcess.length} memories:\n`);
    for (const c of commitsToProcess.slice(0, 20)) {
      console.log(`  ${c.sha.slice(0, 7)} ${c.date.slice(0, 10)} ${c.subject}`);
    }
    if (commitsToProcess.length > 20) {
      console.log(`  ... and ${commitsToProcess.length - 20} more`);
    }
    return;
  }

  // 7. Enrich and 8. batch create
  const BATCH_SIZE = 50;
  let created = 0;
  let errors = 0;

  for (let i = 0; i < commitsToProcess.length; i += BATCH_SIZE) {
    const batch = commitsToProcess.slice(i, i + BATCH_SIZE);

    const memories = batch.map((commit) => {
      const body = getCommitBody(commit.sha);
      const files = depth === "files" ? getChangedFiles(commit.sha) : [];
      const content = formatContent(commit, body, files, depth);

      return {
        content,
        tree: treePath,
        meta: {
          source: "git" as const,
          repo,
          commit: commit.sha,
          author: commit.author,
          branch: branchRef,
        },
        temporal: { start: commit.date },
      };
    });

    try {
      const result = await client.memory.batchCreate({ memories });
      created += result.ids.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Batch error (commits ${i + 1}-${i + batch.length}): ${msg}`);
      errors += batch.length;
    }

    if ((i + BATCH_SIZE) % 100 === 0 && i + BATCH_SIZE < commitsToProcess.length) {
      console.log(`Progress: ${created} created, ${errors} errors`);
    }
  }

  // 9. Update sync cursor
  if (created > 0 && commitsToProcess.length > 0) {
    const lastCommit = commitsToProcess[commitsToProcess.length - 1]!;
    const totalImported = previousTotal + created;
    try {
      await upsertCursor(client, cursor, repo, treePath, lastCommit.sha, lastCommit.date, totalImported);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Warning: failed to update sync cursor: ${msg}`);
    }
  }

  // 10. Report
  const skipped = filtered + deduped;
  console.log(`Done: ${created} created, ${skipped} skipped, ${errors} errors`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
