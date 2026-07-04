#!/usr/bin/env node
// CleanShot X changelog watcher.
//
// Runs weekly (launchd). Fetches the changelog, and ONLY acts when there is a
// genuinely new release. When the new release is API-relevant (a cleanshot://
// command was added/removed vs commands.json, or its changelog notes mention
// the URL Scheme / API), it fires a headless Claude run that drafts a PR
// bringing the fork in sync with https://cleanshot.com/docs-api. Otherwise it
// just records the new version and sends a macOS notification.
//
// Fail-safe: any parse/network failure logs and exits WITHOUT touching state,
// so the next run retries. State is only advanced once a release is handled.
//
// Flags:
//   --dry-run   Detect + diff and print the planned action, but never spawn
//               Claude and never write state. For testing.

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = join(REPO, ".watch");
const STATE_FILE = join(STATE_DIR, "last-seen.json");
const LOG_FILE = join(STATE_DIR, "watch.log");
const MANIFEST_FILE = join(REPO, "commands.json");
const TASK_FILE = join(REPO, "scripts", "update-from-docs.md");

const CHANGELOG_URL = "https://cleanshot.com/changelog";
const DOCS_URL = "https://cleanshot.com/docs-api";
const CLAUDE_BIN = "/Users/danielkam/.local/bin/claude";
const CLAUDE_CONFIG_DIR = "/Users/danielkam/.claude-personal";

const DRY_RUN = process.argv.includes("--dry-run");

async function log(msg) {
  const line = `[${nowISO()}] ${msg}`;
  console.log(line);
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await appendFile(LOG_FILE, line + "\n");
  } catch {}
}

// Date.now()/new Date() are fine in a real Node process (only the workflow
// sandbox forbids them). Kept in one helper so intent is obvious.
function nowISO() {
  return new Date().toISOString();
}

function notify(title, message) {
  // Best-effort macOS notification; never throws.
  try {
    const esc = (s) => String(s).replace(/["\\]/g, "\\$&");
    spawn("osascript", [
      "-e",
      `display notification "${esc(message)}" with title "${esc(title)}"`,
    ]).on("error", () => {});
  } catch {}
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "cleanshot-mcp-watcher/1.0" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

// Latest entry = first <div class="number">X</div><div class="date">Y</div> block.
function parseLatest(html) {
  const re =
    /<div class="number"[^>]*>\s*([\d]+\.[\d]+(?:\.[\d]+)?)\s*<\/div>\s*<div class="date"[^>]*>\s*([^<]+?)\s*<\/div>/i;
  const m = re.exec(html);
  if (!m) return null;
  return { version: m[1].trim(), date: m[2].trim() };
}

// Change bullets of the latest entry (used to detect API-relevant releases).
function parseLatestNotes(html) {
  const block = /<div class="version"[^>]*>([\s\S]*?)<\/div>\s*<ul class="changes"[^>]*>([\s\S]*?)<\/ul>/i.exec(
    html,
  );
  if (!block) return [];
  return [...block[2].matchAll(/<li class="change"[^>]*>([\s\S]*?)<\/li>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
  );
}

// Distinct cleanshot:// command names from docs-api, minus the format placeholder.
function parseDocsCommands(html) {
  const set = new Set();
  for (const m of html.matchAll(/cleanshot:\/\/([a-z][a-z-]*)/gi)) {
    const name = m[1].toLowerCase();
    if (name !== "command-name") set.add(name);
  }
  return set;
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}

async function main() {
  await log(`--- run start${DRY_RUN ? " (dry-run)" : ""} ---`);

  // 1. Detect latest changelog version (fail-safe on any error).
  let latest, changelogHtml;
  try {
    changelogHtml = await fetchText(CHANGELOG_URL);
    latest = parseLatest(changelogHtml);
  } catch (e) {
    await log(`ERROR fetching/parsing changelog: ${e.message}. Exiting without state change.`);
    process.exit(1);
  }
  if (!latest) {
    await log("ERROR: could not parse latest version (markup changed?). Exiting without state change.");
    process.exit(1);
  }
  await log(`latest changelog: ${latest.version} (${latest.date})`);

  // 2. Compare to last-seen.
  let lastSeen = {};
  if (existsSync(STATE_FILE)) {
    try {
      lastSeen = await readJSON(STATE_FILE);
    } catch {}
  }
  if (lastSeen.version === latest.version) {
    await log(`no change (still ${latest.version}).`);
    process.exit(0);
  }
  await log(`NEW version: ${lastSeen.version ?? "(none)"} -> ${latest.version}`);

  // 3. Is this release API-relevant? (command-set delta OR notes mention API/URL scheme)
  let docsHtml, docsCommands;
  try {
    docsHtml = await fetchText(DOCS_URL);
    docsCommands = parseDocsCommands(docsHtml);
  } catch (e) {
    await log(`ERROR fetching docs-api: ${e.message}. Exiting without state change (will retry).`);
    process.exit(1);
  }
  if (docsCommands.size < 10) {
    await log(`ERROR: only ${docsCommands.size} commands parsed from docs-api (parse failure?). Exiting without state change.`);
    process.exit(1);
  }

  const manifest = await readJSON(MANIFEST_FILE);
  const known = new Set(Object.keys(manifest.commands));
  const added = [...docsCommands].filter((c) => !known.has(c)).sort();
  const removed = [...known].filter((c) => !docsCommands.has(c)).sort();

  const notes = parseLatestNotes(changelogHtml);
  const apiMention = notes.some((n) => /url scheme|\bapi\b/i.test(n));

  const apiRelevant = added.length > 0 || removed.length > 0 || apiMention;

  await log(`docs commands: ${docsCommands.size} | added: [${added.join(", ")}] | removed: [${removed.join(", ")}] | notes mention API: ${apiMention}`);

  // 4. Act.
  if (!apiRelevant) {
    await log(`release ${latest.version} has no API-relevant changes; recording and notifying only.`);
    notify(
      "CleanShot X updated",
      `v${latest.version} (${latest.date}) — no URL Scheme API changes. Fork left as-is.`,
    );
    if (!DRY_RUN) await advanceState(latest, added, removed, apiMention);
    process.exit(0);
  }

  const summary =
    `v${latest.version} is API-relevant.` +
    (added.length ? ` New commands: ${added.join(", ")}.` : "") +
    (removed.length ? ` Removed: ${removed.join(", ")}.` : "") +
    (apiMention ? ` Changelog notes reference the URL Scheme/API.` : "");
  await log(summary);

  if (DRY_RUN) {
    await log("dry-run: would spawn headless Claude to draft an API-sync PR. Not spawning; state unchanged.");
    notify("CleanShot X — API change (dry-run)", summary);
    process.exit(0);
  }

  // 5. Fire headless Claude to draft the PR.
  await log("spawning headless Claude to draft API-sync PR...");
  const task = await readFile(TASK_FILE, "utf-8");
  const prompt =
    task +
    `\n\n---\nContext for this run:\n- New CleanShot X version: ${latest.version} (${latest.date})\n- Commands newly in docs-api (not yet implemented): ${added.join(", ") || "(none detected — reconcile params instead)"}\n- Commands removed from docs-api: ${removed.join(", ") || "(none)"}\n- Branch to create: chore/api-sync-${latest.version}\n`;

  const code = await runClaude(prompt);
  if (code === 0) {
    await log("headless Claude finished (exit 0). Assuming PR drafted.");
    notify("CleanShot X — API-sync PR drafted", summary + " Review it on GitHub.");
    await advanceState(latest, added, removed, apiMention);
  } else {
    await log(`headless Claude exited ${code}. Leaving state unchanged so next run retries.`);
    notify("CleanShot X — API-sync FAILED", `${summary} Claude run exited ${code}. Check watch.log.`);
    process.exit(1);
  }
}

async function advanceState(latest, added, removed, apiMention) {
  const state = {
    version: latest.version,
    date: latest.date,
    checkedAt: nowISO(),
    lastDelta: { added, removed, apiMention },
  };
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  await log(`state advanced to ${latest.version}.`);
}

function runClaude(prompt) {
  return new Promise((resolve) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        "-p",
        prompt,
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Bash(git:*) Bash(gh:*) Bash(npm:*) Bash(node:*) Edit Read Write",
      ],
      {
        cwd: REPO,
        env: { ...process.env, CLAUDE_CONFIG_DIR },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", (e) => {
      console.error(`failed to spawn claude: ${e.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

main().catch(async (e) => {
  await log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
