# Agent Guide for bookmark-automation-ts

## Scope
- This file applies to the entire repository.
- No additional nested `AGENTS.md` files were found.
- No Cursor rules (`.cursor/rules/` or `.cursorrules`) or Copilot rules (`.github/copilot-instructions.md`) exist in this repo.

## Quick Context
- Node.js >= 22 (see `package.json`).
- TypeScript + ESM (`"type": "module"`), so local imports use `.js` extensions.
- Primary runtime entry points are built into `dist/` and executed with `node`.

## Commands (Build/Lint/Test)
- Install deps: `npm install`
- Build TypeScript: `npm run build`
- Typecheck only: `npm run typecheck`
- Dev watch (TSX): `npm run dev`
- Start compiled app: `npm run start`
- Run bookmark processor: `npm run process`
- Run backfill job: `npm run backfill`
- Run status reporter: `npm run status`
- Run Obsidian export: `npm run obsidian`
- Run setup wizard: `npm run setup`

### Linting/Formatting (Biome)
- Lint check: `npm run lint`
- Lint with fixes: `npm run lint:fix`
- Format only: `npm run format`

### Tests (Vitest)
- Run all tests: `npm run test`
- Watch tests: `npm run test:watch`
- Run a single test file: `npm run test -- tests/utils.test.ts`
- Run a single test by name: `npm run test -- -t "validateUrl"`
- Run a specific file directly with Vitest: `npx vitest run tests/storage.test.ts`

## Code Style and Conventions

### TypeScript/ESM
- Use ESM syntax everywhere (`import`/`export`).
- Local imports require explicit `.js` extensions (ex: `import { foo } from './utils/foo.js';`).
- Use `import type { ... }` for type-only imports.
- Prefer explicit return types on exported functions.
- Follow strict TS settings (`strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`).
- Prefer `unknown` for caught errors and narrow with helpers (see `src/utils/errors.ts`).

### Formatting (Biome)
- 2-space indentation.
- Single quotes.
- Semicolons always.
- Line width ~120.
- Use `npm run format` to apply canonical formatting.

### Imports
- Order imports: Node built-ins → external packages → internal modules.
- Separate groups with a blank line.
- Use `node:` specifier for Node built-ins (ex: `import { readFile } from 'node:fs/promises';`).

### Naming
- Files use `kebab-case` (ex: `content-extractor.ts`).
- Classes use `PascalCase`.
- Functions/variables use `camelCase`.
- Constants use `UPPER_SNAKE_CASE` when global (ex: `BLOCKED_HOSTS`).
- Types/interfaces use `PascalCase`.

### Types and Data Modeling
- Prefer `type` aliases for unions (see `Category`, `ContentType`, `ContentFormat`).
- Use `interface` for object shapes used across the app.
- Keep API/IO shapes explicit (ex: `RawBirdBookmark`, `ProcessedBookmark`).
- Prefer optional fields (`?`) over `any` when data may be missing.
- Use `null` intentionally when a value can be absent (not `undefined`).

### Error Handling
- Prefer `catch (e: unknown)` and use helpers:
  - `toErrorMessage(e)` for user-friendly messages.
  - `isNodeError(e)` / `hasErrorCode(e)` for IO-specific logic.
  - `ensureError(e)` when you need an `Error` instance.
- Avoid throwing plain strings; throw `Error` objects.
- When handling file IO, be explicit about missing files vs. corruption (see `readJsonSafe`).
- Log with `console.warn` or `console.error` when a failure should be visible but non-fatal.

### Async/Promise Patterns
- Prefer `async`/`await` over raw promise chains.
- Use `Promise.allSettled` when individual failures must not short-circuit a batch.
- Clean up in `finally` blocks (ex: releasing locks, clearing timers).

### Config and Immutability
- App config lives in `src/config.ts` and is frozen (`Object.freeze`).
- Avoid mutating `config` or nested config objects.

### File/Path Handling
- Use `path.join` and helper path utilities in `src/paths.ts`.
- Use `writeJsonAtomic` for writing JSON files to avoid corruption.
- Use file locks (`withFileLock`) for read-modify-write flows.

## Testing Practices
- Tests live in `tests/**/*.test.ts`.
- Use Vitest `describe`/`it`/`expect`.
- Use helper utilities in `tests/helpers/` for temp dirs and snapshot files.
- Favor deterministic tests (avoid real network or time dependencies).

## Security/Networking
- Use `safeFetch` / `safeFetchBinary` for any external URL access.
- Validate URLs with `validateUrl` or `validateUrlWithDNS` before fetching.
- Avoid SSRF risks by following existing validation patterns.

## Claude API Notes
- Structured outputs are in beta for Claude 4.5/4.1 families.
- Enable with the `structured-outputs-2025-11-13` beta header.
- Reference: https://platform.claude.com/docs/en/build-with-claude/structured-outputs

## Project Structure
- `src/` contains runtime code.
- `src/index.ts` is the main polling service entrypoint.
- `src/cli.ts` is the CLI for listing/searching bookmarks.
- `src/process-bookmarks.ts` runs a one-off processing pass.
- `src/backfill.ts` backfills historical bookmarks.
- `src/status.ts` prints status summaries.
- `src/obsidian.ts` exports to Obsidian.
- `src/setup.ts` runs the account setup wizard.
- `tests/` contains Vitest tests and helpers.
- `tests/helpers/` includes temp-dir and snapshot helpers.
- `dist/` contains compiled output (do not edit manually).
- `data/` is runtime storage (generated by running the app).
- `data/processed/{account}/{category}/` stores processed JSON output.

## Environment and Config
- `.env` is loaded via `src/env.ts`; import it before other modules.
- Use the `env` accessor object for env variables.
- Call `validateEnv()` in entrypoints that require credentials.
- Do not commit `.env` or runtime secrets.

## Storage and Files
- Use `paths.ts` helpers for data paths.
- Use `readJsonSafe`/`readJsonWithFallback` for JSON reads.
- Use `writeJsonAtomic` for JSON writes.
- Use `withFileLock` for read-modify-write operations.
- Treat `data/` as generated output.

## Notes for Agents
- Prefer minimal, surgical changes.
- Keep code consistent with existing patterns (see `src/utils/` for canonical helpers).
- If adding new scripts, update `package.json` and this file accordingly.
- Do not add new dependencies without clear need.
- `@steipete/bird` v0.7+ provides native Draft.js article content support.
