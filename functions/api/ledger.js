/**
 * Shared ledger API for Signal Ledger, on Cloudflare Pages Functions + KV.
 *
 * One KV key per person per month: `ledger:<person>:<YYYY-MM>`, holding
 * { "<YYYY-MM-DD>": { blocks, tasks, hours, updatedAt } }. Each person only
 * ever writes their own keys, so the two of you never clobber each other —
 * only your own second tab can, and that is last-writer-wins by design.
 *
 * Reminders are one running list per person, not per day: `tasks:<person>`,
 * holding { items: [{ id, text, due, done, doneAt, createdAt }], migrated }.
 * Only the owner writes their list, so the whole list is replaced on save.
 *
 * Auth is a single shared passphrase in the LEDGER_KEY environment variable
 * (set with `wrangler pages secret put LEDGER_KEY`). It never lives in this
 * repo. With LEDGER_KEY unset the API is open, which is fine locally and is
 * not what you want in production.
 */

const PEOPLE = ["nathan", "karan"];
const MAX_BLOCKS = 80;
const MAX_TEXT = 240;
const MAX_TASKS = 4000;
const MAX_REMINDERS = 400;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function authorized(request, env) {
  const want = env.LEDGER_KEY;
  if (!want) return true;
  const got = request.headers.get("x-ledger-key") || "";
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const str = (v, cap) => (typeof v === "string" ? v.slice(0, cap) : "");

function cleanBlocks(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_BLOCKS)
    .map((b) => ({ t: str(b && b.t, MAX_TEXT), w: str(b && b.w, MAX_TEXT) }))
    .filter((b) => b.t || b.w);
}

function cleanHours(v) {
  const out = {};
  if (!v || typeof v !== "object") return out;
  // Keys are 15-minute slots, "H:MM" with H 0-23 and MM 00/15/30/45.
  for (const k of Object.keys(v)) {
    const m = /^(\d{1,2}):(00|15|30|45)$/.exec(k);
    if (!m || Number(m[1]) > 23) continue;
    if (v[k] === "s" || v[k] === "n") out[k] = v[k];
  }
  return out;
}

function cleanReminders(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_REMINDERS)
    .map((t) => ({
      id: str(t && t.id, 40),
      text: str(t && t.text, 500).trim(),
      due: /^\d{4}-\d{2}-\d{2}$/.test((t && t.due) || "") ? t.due : "",
      done: !!(t && t.done),
      doneAt: t && t.done ? str(t.doneAt, 40) : "",
      createdAt: str(t && t.createdAt, 40),
    }))
    .filter((t) => t.id && t.text);
}

async function readReminders(env) {
  const out = {};
  const docs = await Promise.all(PEOPLE.map((p) => env.LEDGER.get(`tasks:${p}`, "json")));
  PEOPLE.forEach((p, i) => {
    if (docs[i]) out[p] = docs[i];
  });
  return out;
}

async function readAll(env) {
  const names = [];
  let cursor;
  do {
    const page = await env.LEDGER.list({ prefix: "ledger:", cursor });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  const docs = await Promise.all(names.map((n) => env.LEDGER.get(n, "json")));
  const entries = {};
  names.forEach((name, i) => {
    const person = name.split(":")[1];
    const doc = docs[i] || {};
    for (const date of Object.keys(doc)) {
      const e = doc[date] || {};
      entries[`${date}__${person}`] = {
        date,
        person,
        blocks: e.blocks || [],
        tasks: e.tasks || "",
        hours: e.hours || {},
      };
    }
  });
  return entries;
}

async function writeBatch(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const items = Array.isArray(body && body.entries) ? body.entries : [];
  const lists = Array.isArray(body && body.tasks) ? body.tasks : [];
  if (!items.length && !lists.length) return json({ error: "no_entries" }, 400);
  if (items.length > 120) return json({ error: "too_many_entries" }, 400);
  for (const l of lists) {
    if (!l || !PEOPLE.includes(l.person)) return json({ error: "unknown_person" }, 400);
  }

  const groups = new Map();
  for (const it of items) {
    if (!it || !PEOPLE.includes(it.person)) return json({ error: "unknown_person" }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || "")) return json({ error: "bad_date" }, 400);
    const gk = `${it.person}|${it.date.slice(0, 7)}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(it);
  }

  for (const [gk, list] of groups) {
    const [person, month] = gk.split("|");
    const name = `ledger:${person}:${month}`;
    const doc = (await env.LEDGER.get(name, "json")) || {};
    const stamp = new Date().toISOString();
    for (const it of list) {
      doc[it.date] = {
        blocks: cleanBlocks(it.blocks),
        tasks: str(it.tasks, MAX_TASKS),
        hours: cleanHours(it.hours),
        updatedAt: stamp,
      };
    }
    await env.LEDGER.put(name, JSON.stringify(doc));
  }
  for (const l of lists) {
    await env.LEDGER.put(
      `tasks:${l.person}`,
      JSON.stringify({ items: cleanReminders(l.items), migrated: !!l.migrated, updatedAt: new Date().toISOString() }),
    );
  }
  return json({ ok: true, groups: groups.size, lists: lists.length });
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!env.LEDGER) return json({ error: "kv_unbound" }, 503);
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
  if (request.method === "GET") {
    const [entries, tasks] = await Promise.all([readAll(env), readReminders(env)]);
    return json({ entries, tasks });
  }
  if (request.method === "POST") return writeBatch(request, env);
  return json({ error: "method_not_allowed" }, 405);
}
