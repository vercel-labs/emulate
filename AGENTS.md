# Agents

## Package Manager

Use `pnpm` for all package management commands (not npm or yarn).

Exception: End-user install instructions should use `npm` (e.g. `npx emulate`, `npm install emulate`) since npm is universal.

## CLI Invocation

`emulate` is a zsh built-in command (it sets shell emulation mode). Running bare `emulate` in zsh invokes the shell built-in, not the npm binary. Always use `npx emulate` in user-facing CLI examples, docs, skills, help output, and post-command messages. The only exception is when `emulate` appears as a subprocess argument to another tool (e.g. `portless github.emulate emulate start`), where the binary is resolved by the parent process rather than the shell.

## Dependencies

Always check for the latest npm version when adding dependencies. Use `pnpm add <package>` (without version) to get the latest, or verify with `npm view <package> version` first.

## No Emojis

Do not use emojis anywhere in this repository (code, comments, output, docs).

## Dashes

Never use `--` as a dash in prose, comments, or user-facing output. Use an em dash (\u2014) when a dash is needed, but prefer rephrasing to avoid dashes entirely. The only exception is CLI flags (e.g. `--port`).

## Emulator UI Design System

All emulator UIs (inspector pages, OAuth flows, checkout pages, inboxes, etc.) must use the shared design system in `packages/@emulators/core/src/ui.ts`. Never write inline HTML with custom `<style>` tags or standalone `<!DOCTYPE html>` templates in individual emulator packages.

Use the appropriate shared render function for each page type:

- `renderCardPage` for centered card layouts (OAuth sign-in, email detail, checkout)
- `renderErrorPage` for error states
- `renderSettingsPage` for sidebar + main content layouts (OAuth app settings, Slack inspector)
- `renderInspectorPage` for tabbed data dashboards (AWS inspector)
- `renderFormPostPage` for OAuth `form_post` auto-submit redirects
- `renderUserButton` for user selection buttons in OAuth flows

These functions provide the shared `head()` (Geist fonts, favicon, CSS), `emuBar()` header, and "Powered by emulate" footer automatically. Use the existing CSS classes (`.inspector-table`, `.s-card`, `.org-row`, `.badge`, `.empty`, etc.) rather than adding inline styles.

If a new page type cannot be built with the existing render functions and CSS classes, add the new styles and render function to `core/src/ui.ts` so every emulator can reuse them.

## Docs Updates

When a change affects how humans or agents use emulate (new/changed/removed commands, flags, behavior, routes, seed config, or SDK integration), update all of these:

1. `README.md`
2. `skills/*/SKILL.md` (agent skills for each service)
3. `apps/web/` (docs site pages)
4. CLI `--help` output in `packages/emulate/src/index.ts`

## Releasing

Releases are manual, single-PR affairs. The maintainer controls the changelog voice and format. All packages share a single version number (`emulate` + every `@emulators/*`).

To prepare a release:

1. Create a branch (e.g. `prepare-v0.5.0`)
2. Bump the version in `packages/emulate/package.json`
3. Run `pnpm sync-versions` to update all `@emulators/*` packages
4. Write the changelog entry in `CHANGELOG.md`, wrapped in `<!-- release:start -->` and `<!-- release:end -->` markers
5. Remove the `<!-- release:start -->` and `<!-- release:end -->` markers from the previous release entry (only the latest release should have markers)
6. Open a PR and merge to `main`

CI compares the version in `packages/emulate/package.json` to what's on npm. If it differs, it builds, publishes all packages with provenance, and creates the GitHub release automatically. The release body is extracted from the content between the markers.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->