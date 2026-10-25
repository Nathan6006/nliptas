// One-off: create the two original accounts over the data that's already in KV.
//   node scripts/seed-accounts.mjs <out.json> nathan=<months> karan=<months>
// where <months> are the YYYY-MM months that have a ledger:<store>:<month> key.
// Writes a `wrangler kv bulk put` file with user:, social: and months: keys
// for nliu (data under "nathan") and kbahl (data under "karan"), already
// friends, and prints each starting password. It never touches ledger:* or
// tasks:* keys. Hashing matches functions/api/[[path]].js (PBKDF2-SHA256).
import { pbkdf2Sync, randomBytes, randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";

const [out, ...rest] = process.argv.slice(2);
const months = {};
for (const a of rest) {
  const [store, list = ""] = a.split("=");
  months[store] = list.split(",").filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
}
if (!out || !months.nathan || !months.karan) {
  console.error("usage: node scripts/seed-accounts.mjs <out.json> nathan=2026-09,2026-10 karan=2026-09,2026-10");
  process.exit(1);
}
const ITER = 100000;
const ABC = "abcdefghjkmnpqrstuvwxyz23456789";
const password = () => Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => ABC[randomInt(ABC.length)]).join("")).join("-");

const people = [
  { username: "nliu", store: "nathan", friend: "kbahl" },
  { username: "kbahl", store: "karan", friend: "nliu" },
];
const now = new Date().toISOString();
const rows = [];
for (const p of people) {
  const pw = password();
  const salt = randomBytes(16);
  const user = {
    username: p.username,
    store: p.store,
    salt: salt.toString("base64"),
    hash: pbkdf2Sync(pw, salt, ITER, 32, "sha256").toString("base64"),
    iter: ITER,
    pwv: 1,
    createdAt: now,
  };
  rows.push({ key: `user:${p.username}`, value: JSON.stringify(user) });
  rows.push({ key: `social:${p.username}`, value: JSON.stringify({ friends: [p.friend], incoming: [], outgoing: [] }) });
  rows.push({ key: `months:${p.store}`, value: JSON.stringify(months[p.store]) });
  console.log(`${p.username}  ${pw}`);
}
writeFileSync(out, JSON.stringify(rows, null, 2));
