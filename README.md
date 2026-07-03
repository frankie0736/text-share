# Text Share

A small Cloudflare Worker app for sharing Markdown text snippets and documents behind a shared password.

## Features

- Password-protected internal sharing board
- Two-column UI: Markdown snippets on the left, document uploads on the right
- Markdown snippets render as copyable code blocks
- Drag-and-drop document uploads
- Copy protected document download links
- Direct document downloads through the Worker
- Manual delete for every text snippet and document
- Per-item expiration, default 7 days, max 1095 days
- Daily scheduled cleanup for expired D1 metadata and R2 objects
- D1 as metadata source of truth, R2 for text/file bodies

## Stack

- Cloudflare Workers
- Cloudflare D1
- Cloudflare R2
- TypeScript
- Vitest
- Wrangler

## Local Setup

```bash
npm install
cp wrangler.example.toml wrangler.toml
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Set local secrets in `.dev.vars`:

```dotenv
SHARE_PASSWORD=change-me
SESSION_SECRET=replace-with-a-long-random-string
```

## Cloudflare Setup

Create D1 and R2 resources:

```bash
npx wrangler d1 create text-share
npx wrangler r2 bucket create text-share-files
```

Copy the generated D1 `database_id` into `wrangler.toml`, then set production secrets:

```bash
printf 'your-password' | npx wrangler secret put SHARE_PASSWORD
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
```

Run migrations and deploy:

```bash
npm run db:migrate:remote
npm run deploy
```

## Custom Domain

Add a custom domain route to your local `wrangler.toml` when needed:

```toml
routes = [
  { pattern = "paste.example.com", custom_domain = true }
]
```

`wrangler.toml` is intentionally ignored because it contains account-specific Cloudflare resource IDs and routes.

## Data Model

D1 stores item metadata:

- `kind`: `text` or `document`
- `r2_key`: object path in R2
- `file_name`, `file_type`, `file_size`
- `created_at`, `expires_at`

R2 stores the actual Markdown text bodies and document files.

Expired items are hidden immediately by `expires_at` checks. A daily Cron trigger physically deletes expired D1 rows and R2 objects.

## Scripts

```bash
npm test
npm run typecheck
npm run dev
npm run deploy
npm run db:migrate:local
npm run db:migrate:remote
```

## License

MIT
