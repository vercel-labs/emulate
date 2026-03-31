# Agents

## Package Manager

Use `pnpm` for all package management commands (not npm or yarn).

Exception: End-user install instructions should use `npm` (e.g. `npx emulate`, `npm install emulate`) since npm is universal.

## Dependencies

Always check for the latest npm version when adding dependencies. Use `pnpm add <package>` (without version) to get the latest, or verify with `npm view <package> version` first.

## No Emojis

Do not use emojis anywhere in this repository (code, comments, output, docs).

## Dashes

Never use `--` as a dash in prose, comments, or user-facing output. Use an em dash (\u2014) when a dash is needed, but prefer rephrasing to avoid dashes entirely. The only exception is CLI flags (e.g. `--port`).

## Docs Updates

When a change affects how humans or agents use emulate (new/changed/removed commands, flags, behavior, routes, seed config, or SDK integration), update all of these:

1. `README.md`
2. `skills/*/SKILL.md` (agent skills for each service)
3. `apps/web/` (docs site pages)
4. CLI `--help` output in `packages/emulate/src/index.ts`
