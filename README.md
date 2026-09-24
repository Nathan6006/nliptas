# Signal Ledger

Two people plan the next day the night before, then score every hour of the day
that just ended as **signal**, **noise**, or **N/A**. The ratio is tracked over
time so the accountability is quantitative, not vibes.

Live at **https://nlimtas.pages.dev**

## The system

- **Plan** — after 7pm the date defaults to tomorrow. Both schedules sit side by
  side; you edit yours, you can always see the other. Time blocks are free text
  (`10-1045`, `9-sleep`), the way the spreadsheet had them. Tasks go underneath.
- **Score hours** — 6am to 3am, 21 cells. Tap cycles signal → noise → N/A →
  blank. N/A (class, a commitment you couldn't move) is excluded from both sides
  of the ratio, so it neither flatters nor punishes the number.
- **History** — every day in reverse order with both hour strips and both scores.
- **Analysis** — signal share per day, where the hours went, and which clock
  hours actually come out signal for each person.

The headline number is signal ÷ (signal + noise). The raw S:N ratio sits beside it.

## Layout

| Path | What it is |
| --- | --- |
| `signal-ledger.html` | The app. Single source of truth — edit this. |
| `build.sh` | Wraps it into `public/index.html` for static hosting. |
| `public/index.html` | Generated. Committed so Pages needs no build step. |
| `functions/api/ledger.js` | Pages Function: the shared ledger on Cloudflare KV. |

Run `./build.sh` after every edit to `signal-ledger.html`.

The same file also runs as a claude.ai artifact, where it uses that runtime's
shared store instead of the API. Storage is picked at load in this order:
claude.ai db → `/api/ledger` → this browser's localStorage.

## Storage

One KV key per person per month: `ledger:<person>:<YYYY-MM>`, holding every day
in that month. Each person only writes their own keys, so you two can never
clobber each other. Every write is mirrored to localStorage, so a dropped
connection costs nothing.

## First-time setup

```sh
npx wrangler login
npx wrangler kv namespace create LEDGER      # put the id in wrangler.toml
npx wrangler pages project create nlimtas --production-branch main
npx wrangler pages secret put LEDGER_KEY --project-name nlimtas   # shared passphrase
./build.sh && npx wrangler pages deploy public --project-name nlimtas
```

`LEDGER_KEY` is the shared passphrase the site asks for once per device. It
lives only in Cloudflare — never in this repo. With it unset the API is open to
anyone who finds the URL.

## Deploying an update

```sh
./build.sh && npx wrangler pages deploy public --project-name nlimtas
```
