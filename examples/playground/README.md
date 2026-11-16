# emulate playground

One Next.js app that embeds every emulator and lets you switch between playgrounds from the sidebar. Nothing else needs to run: the emulators are served by the app itself under `/emulate/<service>` through `@emulators/adapter-next`.

## Getting started

From the repository root:

```bash
pnpm install
pnpm --filter "playground^..." build
pnpm --filter playground dev
```

Open [http://localhost:3000](http://localhost:3000) and pick a playground. To use another port, set `PORT` (for example `PORT=4100 pnpm --filter playground dev`). The app builds its emulator URLs from `PORT`, so do not use `next dev -p`.

## Flows

Each flow is a small app that uses an emulator the way production code would.

| Playground | Path | What it does |
| --- | --- | --- |
| OAuth sign-in | `/oauth` | Signs in through a provider's consent screen and shows the returned profile |
| Resend magic link | `/resend` | Emails a one-time code with the Resend SDK; read it at `/emulate/resend/inbox` |
| Stripe checkout | `/stripe` | A small store that pays through the hosted checkout page and receives the webhook |
| Twilio SMS verification | `/twilio` | Verifies a phone number with Twilio Verify; read the code at `/emulate/twilio?tab=verify` |
| Vercel Blob sharing | `/blob` | Uploads files with the Vercel Blob SDK and opens them through share links |

## API consoles

Emulators without a flow get a request console at `/services/<name>`. Pick a preset or edit the method, path, headers, and body, then send the request and read the response. Where the emulator has its own inspector, the page links to it.

## How it is put together

- `src/lib/emulators.ts` lists every emulator with its seed data. `src/app/emulate/[...path]/route.ts` serves them all from one handler, so they share one process and reset together when the dev server restarts.
- Each flow lives in its own folders: `src/app/<flow>`, `src/lib/<flow>`, and `src/components/<flow>`. Flows keep separate cookies, so signing in to one does not sign you in to another.
- `src/lib/playgrounds.ts` and `src/lib/services.ts` drive the sidebar and the home page. Add an entry there to add a playground.
- `src/app/v1/[...path]/route.ts` forwards Stripe SDK calls to the Stripe emulator, because the SDK only accepts a host and port.

## Notes

- All emulator state is in memory. Restarting the dev server, or editing `src/lib/emulators.ts`, clears it.
- The Resend flow encrypts its cookies with `AUTH_SECRET`. When the variable is not set, the app generates one at startup, so sessions end when the server restarts. Set `AUTH_SECRET` to 64 hexadecimal characters to keep them.
- The OAuth flow stores its session in an unsigned cookie. That is fine for a local demo and not for production.

Run the Resend cookie tests with `pnpm --filter playground test`.
