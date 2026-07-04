You are updating the `cleanshot-mcp` fork so its tools match the current CleanShot X
URL Scheme API. You are running non-interactively (headless). Work only inside this
repository and use only git, gh, npm, node, and file edits.

## Goal
Bring `src/index.ts`, `src/types.ts`, `commands.json`, and `TOOLS.md` into sync with the
live API documented at https://cleanshot.com/docs-api, then open a pull request.

## Steps
1. Fetch and read https://cleanshot.com/docs-api . Enumerate every `cleanshot://<command>`
   and its parameters (ignore the `cleanshot://command-name` format placeholder).
2. Read `commands.json` (our source-of-truth manifest) and `src/index.ts`. Determine the
   delta: commands present in docs but not implemented, commands implemented but removed
   from docs, and any command whose parameter set changed.
3. For each NEW command, add — following the EXACT existing pattern in `src/index.ts`:
   - a zod schema (mirror the closest existing schema),
   - a tool definition in the `ListToolsRequestSchema` handler (`cleanshot_<command_underscored>`),
   - a `case` in the `CallToolRequestSchema` switch that calls `buildUrl("<command>", params)`
     and `openUrl(...)`.
   Add the matching option interface to `src/types.ts` if the command takes parameters.
   For CHANGED parameters, adjust the existing schema/tool def/case. For REMOVED commands,
   remove the schema, tool def, and case.
4. Update `commands.json` (add/remove entries, fix `params`, set `lastSyncedVersion` to the
   new version passed in the run context below) and `TOOLS.md` to match.
5. Run `npm install` (if needed) and `npm run build`. It MUST compile cleanly. Fix any
   TypeScript errors before proceeding.
6. Create a branch `chore/api-sync-<version>`, commit all changes with a clear message
   summarizing the command/param delta, and push to `origin`.
7. Open a PR with `gh pr create` against `origin` (the fork's default branch). Title:
   `Sync URL Scheme API for CleanShot X <version>`. Body: bullet the added/removed/changed
   commands and note that the build passed.

## Rules
- Do NOT edit files outside this repo. Do NOT touch the `.watch/` directory.
- Do NOT merge the PR — only open it. A human reviews and merges.
- If, after reading the docs, there is actually no code change required (e.g. the release
  only changed prose or params already covered), do not open an empty PR — commit only a
  `commands.json` `lastSyncedVersion` bump if warranted, or make no changes and exit 0.
- Keep the diff minimal and consistent with the surrounding code style.
