# Signal to Noise

Plan the next day the night before, then score every hour of the day that just
ended as **signal** or **noise**, side by side with a friend. The ratio is
tracked over time so the accountability is quantitative, not vibes.

Live at **https://nliptas.pages.dev**

## The system

- **Accounts** — anyone can sign up with a username and password. You edit only
  your own day; the right-hand side is whichever friend you pick from the menu
  at the top.
- **Friends** — send a request by username; once they accept, you can see each
  other's scored hours. Plans (schedule and task list) stay private. The
  Friends tab also has requests, change password and log out.

- **Plan** — defaults to today, with Tomorrow as the next shortcut (Score hours
  offers Yesterday instead). The day rolls over at 3am. Only you see
  your plan. Time blocks are free text
  (`10-1045`, `9-sleep`), the way the spreadsheet had them. Underneath is a
  running task list per person that carries over day to day, with optional due
  dates and nested groups (groups, subgroups, tasks at any level).
- **Score hours** — 6am to 6am as a calendar column in 5-minute steps. Drag to
  paint signal, click a block to switch signal ↔ noise, Backspace to delete.
  Blocks stay as drawn (neighbours never merge); ✂ splits one in two, and
  dragging the line between two touching blocks moves it.
  Selecting a block brings up a bar with signal/noise, label, split, delete
  and ±5-minute start/end steppers. On phones: tap to select, then drag the
  block or its handles straight away; the page scrolls when you drag near the
  edge, and the label menu opens as a bottom sheet.
  Unscored time is left out of both sides of the ratio.
  Marking time signal pops up a menu asking what it was; the menu remembers
  everything you've typed into it, most-used first, and × drops an option.
  Under the label there's an optional Details line (e.g. "history essay").
- **Undo** — ⌘Z / Ctrl+Z and ⇧⌘Z / Ctrl+Y undo and redo your own changes.
- **History** — every day in reverse order with both hour strips and both scores.
- **Analysis** — signal share per day, where the hours went, what the signal
  went to, and which clock hours actually come out signal for each person.

The headline number is signal ÷ (signal + noise). The raw S:N ratio sits beside it.

## Layout

| Path | What it is |
| --- | --- |
| `signal-ledger.html` | The app. Single source of truth — edit this. |
| `build.sh` | Wraps it into `public/index.html` for static hosting. |
| `public/index.html` | Generated. Committed so Pages needs no build step. |
| `functions/api/[[path]].js` | Pages Function: accounts, friends and the ledger on Cloudflare KV. |
| `scripts/seed-accounts.mjs` | One-off that created the nliu and kbahl accounts over the existing data. |

Run `./build.sh` after every edit to `signal-ledger.html`.

## Storage

| KV key | Holds |
| --- | --- |
| `user:<username>` | Password hash, and `store`: where that person's data lives. |
| `social:<username>` | Friends, incoming and outgoing requests. |
| `months:<store>` | Which months have a ledger doc. |
| `ledger:<store>:<YYYY-MM>` | Every day in that month. |
| `tasks:<store>` | The running task list. |

`store` is the username for everyone who signs up. The two original accounts
point at the data from before accounts existed: `nliu` → `nathan`, `kbahl` →
`karan`, so none of it moved (those two names can't be registered). Each person
only writes their own keys. The browser keeps a copy per account, and edits
made offline are sent once the connection is back.

## First-time setup

```sh
npx wrangler login
npx wrangler kv namespace create LEDGER      # put the id in wrangler.toml
npx wrangler pages project create nliptas --production-branch main
openssl rand -base64 48 | npx wrangler pages secret put SESSION_SECRET --project-name nliptas
./build.sh && npx wrangler pages deploy public --project-name nliptas
```

`SESSION_SECRET` signs the sign-in cookies. It lives only in Cloudflare, never
in this repo; changing it signs everyone out. The API refuses to run without it.

## Deploying an update

```sh
./build.sh && npx wrangler pages deploy public --project-name nliptas
```
