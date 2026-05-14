# emulate docs site

This is the Next.js documentation site for `emulate`.

## Development

From the repository root:

```bash
pnpm install
pnpm --filter web dev
```

The docs app runs through `portless` so local demos can use trusted `*.localhost` URLs. If the dev command reports that `portless` is missing, install it with:

```bash
npm install -g portless
```

## Useful Commands

```bash
pnpm --filter web lint
pnpm --filter web build
```

Use `pnpm` for repository development commands. User-facing CLI examples should use `npx emulate`, such as:

```bash
npx emulate
npx emulate --service github,google
```

## Docs Structure

- `app/docs/page.mdx` is the getting started page.
- `app/docs/*/page.mdx` contains service and reference docs.
- `components/docs-nav.tsx` controls the docs sidebar.

When CLI commands, flags, service behavior, seed config, or SDK integration changes, update this site alongside the root README, agent skills, and CLI help output.
