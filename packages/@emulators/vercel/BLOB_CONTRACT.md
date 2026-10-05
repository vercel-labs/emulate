# Blob compatibility contract foundation

This suite exercises real HTTP against a temporary, stateful local emulator. It
is a compatibility foundation, not certification of complete Blob API support.
No production credentials or cloud resources are needed.

## Run

From the repository root, after installing dependencies:

```bash
pnpm --filter @emulators/core build
pnpm --filter @emulators/vercel test:blob-contract
```

The tests also run through the package's normal `test` script. CI runs the
dedicated command with a verbose reporter to distinguish passing contracts,
known gaps, and harness safeguards instead of treating every green test as an
implemented feature.

To see the desired contracts fail against the current implementation, disable
all known-gap allowances (POSIX shell):

```bash
BLOB_CONTRACT_ENFORCE=1 pnpm --filter @emulators/vercel test:blob-contract
```

This mode currently produces nine failing contract cases and a nonzero exit
status. It is for review and implementation work, not the default CI command.

## Compatibility target and provenance

- SDK: `@vercel/blob` exactly `2.4.0`, preserving the previously resolved version.
- Raw HTTP: `x-api-version: 12`.
- API source baseline: `vercel/api` revision
  `d649a49eb8bd43eefc812e0dd75aec8de2af6e38`.
- Desired behaviors were derived from source and interface-test inspection, not
  a production test run. Each known gap records its source file and reason.
- The public Vercel OpenAPI contract does not describe these SDK-facing Blob
  routes. This is not an OpenAPI-generated or exhaustive v12 conformance suite.

The passing group covers binary upload/download and metadata, copy preserving
the source, paginated listing, deletion, missing credentials, conditional PUT,
and conditional content reads. Eight further tests verify the harness itself.

## Executable known gaps

| Stable ID | Desired behavior |
| --- | --- |
| `delete-empty` | Reject an empty deletion batch without changing stored content |
| `delete-malformed` | Reject malformed JSON without changing stored content |
| `copy-source-match` | Accept a source ETag when the destination does not exist |
| `copy-source-mismatch` | Reject a destination ETag that does not match the source |
| `folded-pagination` | Count common prefixes against the page limit |
| `content-type-fallback` | Preserve a Content-Type header on extensionless uploads |
| `cache-minimum` | Clamp modern max-age to at least 60 seconds |
| `leading-slash` | Remove a leading pathname slash |
| `multipart-create` | Create a multipart session without publishing content |

Known-gap tests execute the desired contract and compare the observation with
one exact, documented current mismatch. Only that mismatch is allowed. A new
mismatch, a setup/transport exception, or an unexpected contract success fails
the suite. No tests are skipped, and no broad expected-exception wrapper is used.
The summary labels matched gaps as **not implemented**.

To close a gap in a feature PR:

1. Implement the behavior without changing the desired observation.
2. Verify that the current test fails with `unexpected success`.
3. Replace its `gapCheck` call with ordinary `checkContract`, dropping the
   current-mismatch argument, and move the case into the passing-contract group.
4. Remove its manifest entry and documentation row.
5. Run the dedicated suite and the full Vercel package tests.

Partial implementations may fail as an unexpected mismatch. Do not broaden
the designation to accept arbitrary errors to make an incomplete fix green.

## Isolation and limits

Each case resets the in-memory store. The suite uses a fake public-store token,
binds to `127.0.0.1` on an ephemeral port, and temporarily configures the SDK's
API URL and token. Environment variables and global fetch are restored during
teardown, and the server is closed.

The fetch guard allows only that server's exact origin, rejects URL credentials,
and prevents redirect following. Safeguard tests verify rejection before the
transport is invoked. This protects these global-fetch-based SDK/HTTP tests;
it is not an operating-system network sandbox and does not intercept arbitrary
socket clients or alternate HTTP transports.

Private stores, browser client tokens and callbacks, multipart upload/complete,
rename, presigned operations, image optimization, TTL, legacy versions, and full
CDN behavior remain follow-up work. There is intentionally no fake private-store
lifecycle test: the emulator does not yet model private stores. The multipart
case covers only session creation, not a successful multipart workflow.
