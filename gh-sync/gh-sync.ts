#!/usr/bin/env -S npx tsx
/**
 * gh-sync — Sync GitHub issues, PRs, releases, and CI runs into memory engine.
 *
 * Usage:
 *   ME_SERVER=http://localhost:3000 ME_API_KEY=me_xxx bun gh-sync.ts --repo owner/repo
 *   ME_SERVER=http://localhost:3000 ME_API_KEY=me_xxx npx tsx gh-sync.ts --repo owner/repo
 */

import { execFileSync } from "node:child_process";
import { createClient, type MeClient } from "@memoryengine/client";

// ===== Types =====

type Source = "issues" | "prs" | "releases" | "ci";
type Depth = "summary" | "full";
type State = "open" | "closed" | "merged" | "all";

interface Options {
  server: string;
  apiKey: string;
  repo: string;
  prefix?: string;
  sources: Source[];
  max: number;
  since?: string;
  state: State;
  depth: Depth;
  dryRun: boolean;
}

interface GHIssue {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  state: string;
  labels: { name: string }[];
  createdAt: string;
  closedAt: string | null;
  comments: GHComment[];
}

interface GHPullRequest {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  state: string;
  labels: { name: string }[];
  createdAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  comments: GHComment[];
  reviewDecision: string;
}

interface GHComment {
  author: { login: string };
  body: string;
  createdAt: string;
}

interface GHReleaseListing {
  tagName: string;
  name: string;
  createdAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

interface GHRelease {
  tagName: string;
  name: string;
  body: string;
  author: { login: string };
  createdAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

interface GHRun {
  databaseId: number;
  name: string;
  conclusion: string;
  createdAt: string;
  updatedAt: string;
  headBranch: string;
  event: string;
  status: string;
}

interface GHJob {
  name: string;
  conclusion: string;
  steps: { name: string; conclusion: string }[];
}

interface CursorMemory {
  id: string;
  meta: Record<string, unknown>;
}

interface SyncStats {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

// ===== Constants =====

const ALL_SOURCES: Source[] = ["issues", "prs", "releases", "ci"];
const BATCH_SIZE = 50;
const BODY_MAX_CHARS = 4000;
const BOT_PATTERNS = [/\[bot\]$/, /^dependabot$/, /^dependabot\[bot\]$/, /-bot$/, /^github-actions$/];

// ===== Helpers =====

function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }).trim();
}

function ghJSON<T>(...args: string[]): T {
  const output = gh(...args);
  return JSON.parse(output) as T;
}

function makeLtreeSafe(name: string): string {
  return name.toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]/g, "");
}

function isBot(login: string): boolean {
  return BOT_PATTERNS.some((p) => p.test(login));
}

function truncate(text: string, max: number): string {
  if (!text || text.length <= max) return text ?? "";
  return text.slice(0, max) + "\n\n[... truncated ...]";
}

function formatDate(iso: string | null): string {
  if (!iso) return "N/A";
  return iso.slice(0, 10);
}

// ===== Comment Condensation =====

function condenseComments(comments: GHComment[], author: string): string {
  // Filter bot comments
  const human = comments.filter((c) => c.author?.login && !isBot(c.author.login));
  if (human.length === 0) return "";

  if (human.length <= 5) {
    return human.map((c) => `**${c.author.login}** (${formatDate(c.createdAt)}):\n${truncate(c.body, 1000)}`).join("\n\n");
  }

  // >5 comments: first, last, and author/maintainer comments
  const first = human[0]!;
  const last = human[human.length - 1]!;
  const authorComments = human.filter((c) => c.author.login === author);
  const kept = new Set<GHComment>([first, last, ...authorComments]);
  const condensed = human.length - kept.size;

  const parts: string[] = [];
  parts.push(`**${first.author.login}** (${formatDate(first.createdAt)}):\n${truncate(first.body, 1000)}`);

  for (const c of authorComments) {
    if (c !== first && c !== last) {
      parts.push(`**${c.author.login}** (${formatDate(c.createdAt)}):\n${truncate(c.body, 1000)}`);
    }
  }

  if (condensed > 0) {
    parts.push(`[... ${condensed} comments condensed ...]`);
  }

  if (last !== first) {
    parts.push(`**${last.author.login}** (${formatDate(last.createdAt)}):\n${truncate(last.body, 1000)}`);
  }

  return parts.join("\n\n");
}

// ===== Content Formatting =====

function formatIssueContent(issue: GHIssue, repo: string): string {
  const labels = issue.labels.map((l) => l.name).join(", ");
  let content = `# #${issue.number}: ${issue.title}\n\n`;
  content += `**Repo**: ${repo}\n`;
  content += `**State**: ${issue.state}\n`;
  content += `**Author**: ${issue.author.login}\n`;
  if (labels) content += `**Labels**: ${labels}\n`;
  content += `**Created**: ${formatDate(issue.createdAt)}\n`;
  if (issue.closedAt) content += `**Closed**: ${formatDate(issue.closedAt)}\n`;

  if (issue.body) {
    content += `\n## Description\n${truncate(issue.body, BODY_MAX_CHARS)}\n`;
  }

  const comments = condenseComments(issue.comments ?? [], issue.author.login);
  if (comments) {
    content += `\n## Comments\n${comments}\n`;
  }

  return content;
}

function formatPRContent(pr: GHPullRequest, repo: string, reviews?: string): string {
  const labels = pr.labels.map((l) => l.name).join(", ");
  let content = `# PR #${pr.number}: ${pr.title}\n\n`;
  content += `**Repo**: ${repo}\n`;
  content += `**State**: ${pr.mergedAt ? "merged" : pr.state}\n`;
  content += `**Author**: ${pr.author.login}\n`;
  if (labels) content += `**Labels**: ${labels}\n`;
  if (pr.reviewDecision) content += `**Review Decision**: ${pr.reviewDecision}\n`;
  content += `**Created**: ${formatDate(pr.createdAt)}\n`;
  if (pr.mergedAt) content += `**Merged**: ${formatDate(pr.mergedAt)}\n`;
  else if (pr.closedAt) content += `**Closed**: ${formatDate(pr.closedAt)}\n`;

  if (pr.body) {
    content += `\n## Description\n${truncate(pr.body, BODY_MAX_CHARS)}\n`;
  }

  if (reviews) {
    content += `\n## Reviews\n${reviews}\n`;
  }

  const comments = condenseComments(pr.comments ?? [], pr.author.login);
  if (comments) {
    content += `\n## Comments\n${comments}\n`;
  }

  return content;
}

function formatReleaseContent(release: GHRelease, repo: string): string {
  let content = `# Release: ${release.name || release.tagName}\n\n`;
  content += `**Repo**: ${repo}\n`;
  content += `**Tag**: ${release.tagName}\n`;
  content += `**Author**: ${release.author.login}\n`;
  content += `**Date**: ${formatDate(release.createdAt)}\n`;
  if (release.isPrerelease) content += `**Pre-release**: yes\n`;

  if (release.body) {
    content += `\n## Release Notes\n${truncate(release.body, BODY_MAX_CHARS)}\n`;
  }

  return content;
}

function formatCIRunContent(run: GHRun, repo: string, failedJobs?: GHJob[]): string {
  let content = `# CI: ${run.name}\n\n`;
  content += `**Repo**: ${repo}\n`;
  content += `**Workflow**: ${run.name}\n`;
  content += `**Event**: ${run.event}\n`;
  content += `**Branch**: ${run.headBranch}\n`;
  content += `**Conclusion**: ${run.conclusion || run.status}\n`;
  content += `**Started**: ${formatDate(run.createdAt)}\n`;
  content += `**Updated**: ${formatDate(run.updatedAt)}\n`;

  if (run.createdAt && run.updatedAt) {
    const durationMs = new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime();
    if (durationMs > 0) {
      const mins = Math.floor(durationMs / 60000);
      const secs = Math.floor((durationMs % 60000) / 1000);
      content += `**Duration**: ${mins}m ${secs}s\n`;
    }
  }

  if (failedJobs && failedJobs.length > 0) {
    content += "\n## Failed Jobs\n";
    for (const job of failedJobs) {
      content += `\n### ${job.name}\n`;
      const failedSteps = job.steps?.filter((s) => s.conclusion === "failure") ?? [];
      if (failedSteps.length > 0) {
        for (const step of failedSteps) {
          content += `- **FAILED**: ${step.name}\n`;
        }
      }
    }
  }

  return content;
}

// ===== PR Reviews =====

function fetchPRReviews(repo: string, number: number): string {
  try {
    const reviews = ghJSON<{ author: { login: string }; state: string; body: string }[]>(
      "api",
      `repos/${repo}/pulls/${number}/reviews`,
    );
    const meaningful = reviews.filter((r) => r.body?.trim() || r.state !== "COMMENTED");
    if (meaningful.length === 0) return "";

    return meaningful
      .map((r) => {
        const body = r.body?.trim() ? `\n${truncate(r.body, 1000)}` : "";
        return `**${r.author?.login ?? "unknown"}** — ${r.state}${body}`;
      })
      .join("\n\n");
  } catch {
    return "";
  }
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
      case "--sources":
        opts.sources = (args[++i] ?? "").split(",").map((s) => s.trim()) as Source[];
        break;
      case "--max":
        opts.max = parseInt(args[++i] ?? "100", 10);
        break;
      case "--since":
        opts.since = args[++i];
        break;
      case "--state":
        opts.state = args[++i] as State;
        break;
      case "--depth":
        opts.depth = args[++i] as Depth;
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
  console.log(`Usage: gh-sync.ts [options]

Auth (env vars or flags):
  ME_SERVER=<url>          Server URL (default: http://localhost:3000)
  ME_API_KEY=<key>         API key for authentication

Options:
  --server <url>           Override ME_SERVER env var
  --api-key <key>          Override ME_API_KEY env var
  --repo <owner/repo>      GitHub repo (default: detect from git remote via gh)
  --prefix <tree.path>     Tree prefix (default: auto-detect repo name)
  --sources <list>         Comma-separated: issues,prs,releases,ci (default: all)
  --max <n>                Max items per source per run (default: 100)
  --since <date>           Only items after this ISO date
  --state <state>          Filter: open, closed, merged, all (default: all)
  --depth <level>          summary | full (default: full)
  --dry-run                Preview without creating memories
  -h, --help               Show this help`);
}

// ===== Sync Cursor =====

async function findCursor(client: MeClient, repo: string, entityType: string): Promise<CursorMemory | null> {
  const result = await client.memory.search({
    meta: { source: "github", repo, type: "sync_cursor", entity_type: entityType },
    limit: 1,
  });
  const m = result.results[0];
  if (m) return { id: m.id, meta: m.meta };
  return null;
}

async function upsertCursor(
  client: MeClient,
  cursor: CursorMemory | null,
  repo: string,
  treePath: string,
  entityType: string,
  lastUpdated: string,
  totalImported: number,
): Promise<void> {
  const meta = {
    source: "github",
    repo,
    type: "sync_cursor",
    entity_type: entityType,
    last_updated: lastUpdated,
    total_imported: totalImported,
  };
  const content = `GitHub sync cursor for ${repo} ${entityType}. Last update: ${lastUpdated}. Total: ${totalImported}.`;

  if (cursor) {
    await client.memory.update({ id: cursor.id, content, meta });
  } else {
    await client.memory.create({ content, tree: `${treePath}._sync`, meta });
  }
}

// ===== Detect Repo =====

function detectRepo(): { nameWithOwner: string; name: string } {
  try {
    return ghJSON<{ nameWithOwner: string; name: string }>("repo", "view", "--json", "nameWithOwner,name");
  } catch {
    throw new Error("Could not detect repo. Use --repo <owner/repo> or run from a git repo with a GitHub remote.");
  }
}

// ===== Source Sync Functions =====

async function syncIssues(client: MeClient, opts: Options, treePath: string): Promise<SyncStats> {
  const stats: SyncStats = { created: 0, updated: 0, skipped: 0, errors: 0 };
  const entityType = "issues";
  const tree = `${treePath}.github.issues`;

  // Find cursor
  const cursor = await findCursor(client, opts.repo, entityType);
  const previousTotal = (cursor?.meta.total_imported as number) ?? 0;
  const cursorDate = (cursor?.meta.last_updated as string) ?? opts.since;

  if (cursor) {
    console.log(`  Cursor: last updated ${cursorDate}, ${previousTotal} imported`);
  }

  // Build gh command
  const ghArgs = ["issue", "list", "--repo", opts.repo, "--limit", String(opts.max),
    "--json", "number,title,body,author,state,labels,createdAt,closedAt,comments"];

  if (opts.state !== "all") {
    ghArgs.push("--state", opts.state);
  } else {
    ghArgs.push("--state", "all");
  }

  if (cursorDate) {
    ghArgs.push("--search", `updated:>=${cursorDate.slice(0, 10)}`);
  }

  let issues: GHIssue[];
  try {
    issues = ghJSON<GHIssue[]>(...ghArgs);
  } catch (err) {
    console.error(`  Error fetching issues: ${err instanceof Error ? err.message : err}`);
    stats.errors++;
    return stats;
  }

  // Filter bots and empty
  issues = issues.filter((i) => {
    if (!i.author?.login || isBot(i.author.login)) return false;
    if (!i.title?.trim()) return false;
    return true;
  });

  console.log(`  Fetched ${issues.length} issues`);
  if (issues.length === 0) return stats;

  // Dedup: search for existing by number
  const existingMap = new Map<number, string>();
  for (let i = 0; i < issues.length; i += 50) {
    const batch = issues.slice(i, i + 50);
    for (const issue of batch) {
      try {
        const existing = await client.memory.search({
          meta: { source: "github", repo: opts.repo, entity_type: "issue", number: issue.number },
          limit: 1,
        });
        if (existing.results.length > 0) {
          existingMap.set(issue.number, existing.results[0]!.id);
        }
      } catch {
        // ignore search errors
      }
    }
  }

  // Dry run
  if (opts.dryRun) {
    for (const issue of issues) {
      const action = existingMap.has(issue.number) ? "UPDATE" : "CREATE";
      console.log(`  [${action}] #${issue.number}: ${issue.title}`);
    }
    stats.created = issues.filter((i) => !existingMap.has(i.number)).length;
    stats.updated = issues.filter((i) => existingMap.has(i.number)).length;
    return stats;
  }

  // Batch create new, update existing
  const toCreate: {
    content: string;
    tree: string;
    meta: Record<string, unknown>;
    temporal: { start: string; end?: string };
  }[] = [];

  let latestUpdate = cursorDate ?? "";

  for (const issue of issues) {
    const content = formatIssueContent(issue, opts.repo);
    const labels = issue.labels.map((l) => l.name);
    const meta: Record<string, unknown> = {
      source: "github",
      repo: opts.repo,
      entity_type: "issue",
      number: issue.number,
      state: issue.state,
      author: issue.author.login,
    };
    if (labels.length > 0) meta.labels = labels;

    const temporal: { start: string; end?: string } = { start: issue.createdAt };
    if (issue.closedAt) temporal.end = issue.closedAt;

    // Track latest update time
    const updateTime = issue.closedAt ?? issue.createdAt;
    if (updateTime > latestUpdate) latestUpdate = updateTime;

    const existingId = existingMap.get(issue.number);
    if (existingId) {
      try {
        await client.memory.update({ id: existingId, content, meta, temporal });
        stats.updated++;
      } catch (err) {
        console.error(`  Error updating #${issue.number}: ${err instanceof Error ? err.message : err}`);
        stats.errors++;
      }
    } else {
      toCreate.push({ content, tree, meta, temporal });
    }
  }

  // Batch create
  for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
    const batch = toCreate.slice(i, i + BATCH_SIZE);
    try {
      const result = await client.memory.batchCreate({ memories: batch });
      stats.created += result.ids.length;
    } catch (err) {
      console.error(`  Batch create error: ${err instanceof Error ? err.message : err}`);
      stats.errors += batch.length;
    }
  }

  // Update cursor
  if ((stats.created > 0 || stats.updated > 0) && latestUpdate) {
    try {
      await upsertCursor(client, cursor, opts.repo, treePath, entityType, latestUpdate, previousTotal + stats.created);
    } catch (err) {
      console.error(`  Warning: cursor update failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return stats;
}

async function syncPRs(client: MeClient, opts: Options, treePath: string): Promise<SyncStats> {
  const stats: SyncStats = { created: 0, updated: 0, skipped: 0, errors: 0 };
  const entityType = "prs";
  const tree = `${treePath}.github.prs`;

  const cursor = await findCursor(client, opts.repo, entityType);
  const previousTotal = (cursor?.meta.total_imported as number) ?? 0;
  const cursorDate = (cursor?.meta.last_updated as string) ?? opts.since;

  if (cursor) {
    console.log(`  Cursor: last updated ${cursorDate}, ${previousTotal} imported`);
  }

  const ghArgs = ["pr", "list", "--repo", opts.repo, "--limit", String(opts.max),
    "--json", "number,title,body,author,state,labels,createdAt,closedAt,mergedAt,comments,reviewDecision"];

  if (opts.state !== "all") {
    ghArgs.push("--state", opts.state === "closed" ? "closed" : opts.state === "merged" ? "merged" : opts.state);
  } else {
    ghArgs.push("--state", "all");
  }

  if (cursorDate) {
    ghArgs.push("--search", `updated:>=${cursorDate.slice(0, 10)}`);
  }

  let prs: GHPullRequest[];
  try {
    prs = ghJSON<GHPullRequest[]>(...ghArgs);
  } catch (err) {
    console.error(`  Error fetching PRs: ${err instanceof Error ? err.message : err}`);
    stats.errors++;
    return stats;
  }

  // Filter bots and drafts
  prs = prs.filter((pr) => {
    if (!pr.author?.login || isBot(pr.author.login)) return false;
    if (!pr.title?.trim()) return false;
    return true;
  });

  console.log(`  Fetched ${prs.length} PRs`);
  if (prs.length === 0) return stats;

  // Dedup
  const existingMap = new Map<number, string>();
  for (const pr of prs) {
    try {
      const existing = await client.memory.search({
        meta: { source: "github", repo: opts.repo, entity_type: "pr", number: pr.number },
        limit: 1,
      });
      if (existing.results.length > 0) {
        existingMap.set(pr.number, existing.results[0]!.id);
      }
    } catch {
      // ignore
    }
  }

  if (opts.dryRun) {
    for (const pr of prs) {
      const action = existingMap.has(pr.number) ? "UPDATE" : "CREATE";
      console.log(`  [${action}] PR #${pr.number}: ${pr.title}`);
    }
    stats.created = prs.filter((p) => !existingMap.has(p.number)).length;
    stats.updated = prs.filter((p) => existingMap.has(p.number)).length;
    return stats;
  }

  const toCreate: {
    content: string;
    tree: string;
    meta: Record<string, unknown>;
    temporal: { start: string; end?: string };
  }[] = [];

  let latestUpdate = cursorDate ?? "";

  for (const pr of prs) {
    // Fetch reviews for full depth
    let reviews = "";
    if (opts.depth === "full") {
      reviews = fetchPRReviews(opts.repo, pr.number);
    }

    const content = formatPRContent(pr, opts.repo, reviews);
    const labels = pr.labels.map((l) => l.name);
    const meta: Record<string, unknown> = {
      source: "github",
      repo: opts.repo,
      entity_type: "pr",
      number: pr.number,
      state: pr.mergedAt ? "merged" : pr.state,
      author: pr.author.login,
    };
    if (labels.length > 0) meta.labels = labels;
    if (pr.reviewDecision) meta.review_decision = pr.reviewDecision;

    const temporal: { start: string; end?: string } = { start: pr.createdAt };
    if (pr.mergedAt) temporal.end = pr.mergedAt;
    else if (pr.closedAt) temporal.end = pr.closedAt;

    const updateTime = pr.mergedAt ?? pr.closedAt ?? pr.createdAt;
    if (updateTime > latestUpdate) latestUpdate = updateTime;

    const existingId = existingMap.get(pr.number);
    if (existingId) {
      try {
        await client.memory.update({ id: existingId, content, meta, temporal });
        stats.updated++;
      } catch (err) {
        console.error(`  Error updating PR #${pr.number}: ${err instanceof Error ? err.message : err}`);
        stats.errors++;
      }
    } else {
      toCreate.push({ content, tree, meta, temporal });
    }
  }

  for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
    const batch = toCreate.slice(i, i + BATCH_SIZE);
    try {
      const result = await client.memory.batchCreate({ memories: batch });
      stats.created += result.ids.length;
    } catch (err) {
      console.error(`  Batch create error: ${err instanceof Error ? err.message : err}`);
      stats.errors += batch.length;
    }
  }

  if ((stats.created > 0 || stats.updated > 0) && latestUpdate) {
    try {
      await upsertCursor(client, cursor, opts.repo, treePath, entityType, latestUpdate, previousTotal + stats.created);
    } catch (err) {
      console.error(`  Warning: cursor update failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return stats;
}

async function syncReleases(client: MeClient, opts: Options, treePath: string): Promise<SyncStats> {
  const stats: SyncStats = { created: 0, updated: 0, skipped: 0, errors: 0 };
  const entityType = "releases";
  const tree = `${treePath}.github.releases`;

  const cursor = await findCursor(client, opts.repo, entityType);
  const previousTotal = (cursor?.meta.total_imported as number) ?? 0;
  const cursorDate = (cursor?.meta.last_updated as string) ?? opts.since;

  if (cursor) {
    console.log(`  Cursor: last updated ${cursorDate}, ${previousTotal} imported`);
  }

  // gh release list only supports a limited set of fields (no body/author)
  let listings: GHReleaseListing[];
  try {
    listings = ghJSON<GHReleaseListing[]>(
      "release", "list", "--repo", opts.repo, "--limit", String(opts.max),
      "--json", "tagName,name,createdAt,isDraft,isPrerelease",
    );
  } catch (err) {
    console.error(`  Error fetching releases: ${err instanceof Error ? err.message : err}`);
    stats.errors++;
    return stats;
  }

  // Filter drafts and by cursor date
  listings = listings.filter((r) => {
    if (r.isDraft) return false;
    if (cursorDate && r.createdAt < cursorDate) return false;
    return true;
  });

  // Fetch full details (body, author) per release via gh release view
  const releases: GHRelease[] = [];
  for (const listing of listings) {
    try {
      const detail = ghJSON<GHRelease>(
        "release", "view", listing.tagName, "--repo", opts.repo,
        "--json", "tagName,name,body,author,createdAt,isDraft,isPrerelease",
      );
      if (detail.author?.login && isBot(detail.author.login)) continue;
      releases.push(detail);
    } catch {
      // If view fails, create a release with listing data only
      releases.push({
        ...listing,
        body: "",
        author: { login: "unknown" },
      });
    }
  }

  console.log(`  Fetched ${releases.length} releases`);
  if (releases.length === 0) return stats;

  // Dedup by tag
  const existingMap = new Map<string, string>();
  for (const release of releases) {
    try {
      const existing = await client.memory.search({
        meta: { source: "github", repo: opts.repo, entity_type: "release", tag: release.tagName },
        limit: 1,
      });
      if (existing.results.length > 0) {
        existingMap.set(release.tagName, existing.results[0]!.id);
      }
    } catch {
      // ignore
    }
  }

  if (opts.dryRun) {
    for (const release of releases) {
      const action = existingMap.has(release.tagName) ? "UPDATE" : "CREATE";
      console.log(`  [${action}] ${release.tagName}: ${release.name || release.tagName}`);
    }
    stats.created = releases.filter((r) => !existingMap.has(r.tagName)).length;
    stats.updated = releases.filter((r) => existingMap.has(r.tagName)).length;
    return stats;
  }

  const toCreate: {
    content: string;
    tree: string;
    meta: Record<string, unknown>;
    temporal: { start: string };
  }[] = [];

  let latestUpdate = cursorDate ?? "";

  for (const release of releases) {
    const content = formatReleaseContent(release, opts.repo);
    const meta: Record<string, unknown> = {
      source: "github",
      repo: opts.repo,
      entity_type: "release",
      tag: release.tagName,
      author: release.author.login,
      prerelease: release.isPrerelease,
    };

    const temporal = { start: release.createdAt };

    if (release.createdAt > latestUpdate) latestUpdate = release.createdAt;

    const existingId = existingMap.get(release.tagName);
    if (existingId) {
      try {
        await client.memory.update({ id: existingId, content, meta, temporal });
        stats.updated++;
      } catch (err) {
        console.error(`  Error updating ${release.tagName}: ${err instanceof Error ? err.message : err}`);
        stats.errors++;
      }
    } else {
      toCreate.push({ content, tree, meta, temporal });
    }
  }

  for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
    const batch = toCreate.slice(i, i + BATCH_SIZE);
    try {
      const result = await client.memory.batchCreate({ memories: batch });
      stats.created += result.ids.length;
    } catch (err) {
      console.error(`  Batch create error: ${err instanceof Error ? err.message : err}`);
      stats.errors += batch.length;
    }
  }

  if ((stats.created > 0 || stats.updated > 0) && latestUpdate) {
    try {
      await upsertCursor(client, cursor, opts.repo, treePath, entityType, latestUpdate, previousTotal + stats.created);
    } catch (err) {
      console.error(`  Warning: cursor update failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return stats;
}

async function syncCIRuns(client: MeClient, opts: Options, treePath: string): Promise<SyncStats> {
  const stats: SyncStats = { created: 0, updated: 0, skipped: 0, errors: 0 };
  const entityType = "ci_runs";
  const tree = `${treePath}.github.ci_runs`;

  const cursor = await findCursor(client, opts.repo, entityType);
  const previousTotal = (cursor?.meta.total_imported as number) ?? 0;
  const cursorDate = (cursor?.meta.last_updated as string) ?? opts.since;

  if (cursor) {
    console.log(`  Cursor: last updated ${cursorDate}, ${previousTotal} imported`);
  }

  let runs: GHRun[];
  try {
    runs = ghJSON<GHRun[]>(
      "run", "list", "--repo", opts.repo, "--limit", String(opts.max),
      "--json", "databaseId,name,conclusion,createdAt,updatedAt,headBranch,event,status",
    );
  } catch (err) {
    console.error(`  Error fetching CI runs: ${err instanceof Error ? err.message : err}`);
    stats.errors++;
    return stats;
  }

  // Filter by cursor date and completed status
  runs = runs.filter((r) => {
    if (r.status !== "completed") return false;
    if (cursorDate && r.updatedAt < cursorDate) return false;
    return true;
  });

  console.log(`  Fetched ${runs.length} CI runs`);
  if (runs.length === 0) return stats;

  // Dedup by run_id
  const existingMap = new Map<number, string>();
  for (const run of runs) {
    try {
      const existing = await client.memory.search({
        meta: { source: "github", repo: opts.repo, entity_type: "ci_run", run_id: run.databaseId },
        limit: 1,
      });
      if (existing.results.length > 0) {
        existingMap.set(run.databaseId, existing.results[0]!.id);
      }
    } catch {
      // ignore
    }
  }

  if (opts.dryRun) {
    for (const run of runs) {
      const action = existingMap.has(run.databaseId) ? "UPDATE" : "CREATE";
      console.log(`  [${action}] Run ${run.databaseId}: ${run.name} (${run.conclusion})`);
    }
    stats.created = runs.filter((r) => !existingMap.has(r.databaseId)).length;
    stats.updated = runs.filter((r) => existingMap.has(r.databaseId)).length;
    return stats;
  }

  const toCreate: {
    content: string;
    tree: string;
    meta: Record<string, unknown>;
    temporal: { start: string; end?: string };
  }[] = [];

  let latestUpdate = cursorDate ?? "";

  for (const run of runs) {
    // Fetch failed job details for full depth
    let failedJobs: GHJob[] | undefined;
    if (opts.depth === "full" && run.conclusion === "failure") {
      try {
        const detail = ghJSON<{ jobs: GHJob[] }>("run", "view", String(run.databaseId), "--repo", opts.repo, "--json", "jobs");
        failedJobs = detail.jobs?.filter((j) => j.conclusion === "failure");
      } catch {
        // ignore
      }
    }

    const content = formatCIRunContent(run, opts.repo, failedJobs);
    const meta: Record<string, unknown> = {
      source: "github",
      repo: opts.repo,
      entity_type: "ci_run",
      run_id: run.databaseId,
      workflow: run.name,
      conclusion: run.conclusion,
      branch: run.headBranch,
      event: run.event,
    };

    const temporal: { start: string; end?: string } = { start: run.createdAt };
    if (run.updatedAt) temporal.end = run.updatedAt;

    if (run.updatedAt > latestUpdate) latestUpdate = run.updatedAt;

    const existingId = existingMap.get(run.databaseId);
    if (existingId) {
      try {
        await client.memory.update({ id: existingId, content, meta, temporal });
        stats.updated++;
      } catch (err) {
        console.error(`  Error updating run ${run.databaseId}: ${err instanceof Error ? err.message : err}`);
        stats.errors++;
      }
    } else {
      toCreate.push({ content, tree, meta, temporal });
    }
  }

  for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
    const batch = toCreate.slice(i, i + BATCH_SIZE);
    try {
      const result = await client.memory.batchCreate({ memories: batch });
      stats.created += result.ids.length;
    } catch (err) {
      console.error(`  Batch create error: ${err instanceof Error ? err.message : err}`);
      stats.errors += batch.length;
    }
  }

  if ((stats.created > 0 || stats.updated > 0) && latestUpdate) {
    try {
      await upsertCursor(client, cursor, opts.repo, treePath, entityType, latestUpdate, previousTotal + stats.created);
    } catch (err) {
      console.error(`  Warning: cursor update failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return stats;
}

// ===== Main =====

async function main(): Promise<void> {
  const cliOpts = parseArgs();

  // 1. Resolve auth
  const server = cliOpts.server ?? process.env.ME_SERVER ?? "http://localhost:3000";
  const apiKey = cliOpts.apiKey ?? process.env.ME_API_KEY ?? "";

  if (!apiKey) {
    console.error("Error: ME_API_KEY not set. Use --api-key <key> or set ME_API_KEY env var.");
    process.exit(1);
  }

  // 2. Validate gh CLI
  try {
    gh("auth", "status");
  } catch {
    console.error("Error: gh CLI not authenticated. Run 'gh auth login' first.");
    process.exit(1);
  }

  // 3. Detect repo
  let repo: string;
  let repoName: string;
  if (cliOpts.repo) {
    repo = cliOpts.repo;
    repoName = repo.includes("/") ? repo.split("/")[1]! : repo;
  } else {
    const detected = detectRepo();
    repo = detected.nameWithOwner;
    repoName = detected.name;
  }

  // 4. Build options
  const prefix = cliOpts.prefix ?? makeLtreeSafe(repoName);
  const sources = cliOpts.sources ?? ALL_SOURCES;
  const opts: Options = {
    server,
    apiKey,
    repo,
    prefix: cliOpts.prefix,
    sources,
    max: cliOpts.max ?? 100,
    since: cliOpts.since,
    state: cliOpts.state ?? "all",
    depth: cliOpts.depth ?? "full",
    dryRun: cliOpts.dryRun ?? false,
  };

  console.log(`Repo: ${repo} | Prefix: ${prefix} | Sources: ${sources.join(",")} | Depth: ${opts.depth}${opts.dryRun ? " | DRY RUN" : ""}`);

  // 5. Create client
  const client = createClient({ server, apiKey });

  // 6. Sync each source
  const allStats: Record<string, SyncStats> = {};

  for (const source of sources) {
    console.log(`\nSyncing ${source}...`);
    try {
      switch (source) {
        case "issues":
          allStats.issues = await syncIssues(client, opts, prefix);
          break;
        case "prs":
          allStats.prs = await syncPRs(client, opts, prefix);
          break;
        case "releases":
          allStats.releases = await syncReleases(client, opts, prefix);
          break;
        case "ci":
          allStats.ci = await syncCIRuns(client, opts, prefix);
          break;
        default:
          console.error(`  Unknown source: ${source}`);
      }
    } catch (err) {
      console.error(`  Fatal error syncing ${source}: ${err instanceof Error ? err.message : err}`);
      allStats[source] = { created: 0, updated: 0, skipped: 0, errors: 1 };
    }
  }

  // 7. Report
  console.log("\n=== Summary ===");
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalErrors = 0;

  for (const [source, s] of Object.entries(allStats)) {
    console.log(`  ${source}: ${s.created} created, ${s.updated} updated, ${s.skipped} skipped, ${s.errors} errors`);
    totalCreated += s.created;
    totalUpdated += s.updated;
    totalErrors += s.errors;
  }

  console.log(`  Total: ${totalCreated} created, ${totalUpdated} updated, ${totalErrors} errors`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
