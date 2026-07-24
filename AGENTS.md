# Agents

## Build and Verify

Requires Node `>=24` and pnpm `>=11 <12` (see `engines` in the root `package.json`).

```bash
pnpm install
pnpm build        # turbo build across the workspace
pnpm test         # vitest, per package
pnpm lint
pnpm type-check
pnpm format       # prettier --write; pnpm format:check to verify only
```

`turbo.json` marks `test` with `dependsOn: ["^build"]`, but each package's own
test script is a bare `vitest run`. Packages resolve their workspace deps through
`dist/`, which is gitignored and has no `postinstall` step — so **run `pnpm build`
at least once before running tests directly in a package**, or you get
`Cannot find module '.../dist/index.js'`. The same applies before running anything
in `examples/`.

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

1. `README.md` — also the npm page for the `emulate` package (copied on `prepack`)
2. `packages/@emulators/<service>/README.md` — the npm page for that package
3. `skills/*/SKILL.md` (agent skills for each service)
4. `apps/web/app/docs/**` (docs site pages)
5. `emulate.config.example.yaml`, if seed config changed
6. `examples/`, if the change affects how an example is set up or run
7. CLI `--help` output in `packages/emulate/src/index.ts`

### Adding a service

Registration lives in `packages/emulate/src/registry.ts`, not `index.ts` (which is
generic). Add the name to `SERVICE_NAME_LIST` and an entry to `SERVICE_REGISTRY`
with all five `ServiceEntry` fields (`label`, `endpoints`, `load()`,
`defaultFallback()`, `initConfig`), plus the package to `packages/emulate/package.json`.

A new service is not done until it also has:

- `packages/@emulators/<service>/README.md`
- `apps/web/app/docs/<service>/page.mdx`
- `skills/<service>/SKILL.md`
- entries in `apps/web/lib/docs-navigation.ts`, `apps/web/lib/page-titles.ts`,
  `apps/web/components/docs-nav.tsx` **and** `apps/web/components/docs-mobile-nav.tsx`
  (four separate lists — missing any one leaves the page orphaned)
- the port table updated in `README.md`, `apps/web/app/docs/page.mdx`,
  `skills/emulate/SKILL.md` and `apps/web/components/hero-terminal.tsx`

### Which document is canonical

Seed config is **not validated anywhere**, so a wrong key in the docs produces
silently missing data rather than an error. When documenting seed config, copy the
field names from the service's `*SeedConfig` interface in
`packages/@emulators/<service>/src/index.ts` — that interface is the source of
truth, and the docs must match it exactly.

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