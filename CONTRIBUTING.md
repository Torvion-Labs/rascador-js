# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```sh
npm install
npm run typecheck
npm test
npm run build
npm run lint:package   # publint + are-the-types-wrong
```

## Ground rules

- **No runtime dependencies.** The SDK has to run anywhere `fetch` does.
- **Mirror the API, don't reshape it.** Types in `src/types.ts` match the gateway's `/v1`
  schemas field for field, snake_case included. If the API changes, update them to match.
- **Public API needs explicit types.** `isolatedDeclarations` is on so JSR can publish without
  inferring types; `tsc` tells you where one is missing.
- **Add a changeset** (`npx changeset`) to any PR that changes what gets published.

## Releasing

Merged changesets open a "Version packages" PR. Merging it publishes to npm (with provenance)
and JSR from GitHub Actions. Nobody publishes from a laptop.
