/**
 * Signal to Noise API, on Cloudflare Pages Functions + KV.
 *
 * Accounts: `user:<username>` holds { username, store, salt, hash, iter, pwv,
 * createdAt } and is written only on sign-up and password change. `store`
 * names where that person's data lives; it is the username for everyone who
 * signs up, and the old fixed names for the two original accounts
 * (nliu -> "nathan", kbahl -> "karan"), so their history never had to move.
 * `pwv` bumps on every password change, which signs out old sessions.
 * `social:<username>` holds { friends, incoming, outgoing }, and
 * `months:<store>` the YYYY-MM months that have a ledger doc, so reads don't
 * need a KV list. Each is its own key so no write can clobber another kind.
 *
 * Ledger: one KV key per person per month, `ledger:<store>:<YYYY-MM>`, holding
 * { "<YYYY-MM-DD>": { step, blocks, tasks, hours, areas, segs, notes, updatedAt } }.
 * `step` is 5 for days in 5-minute slots; days without it are in 15-minute
 * slots and the client spreads them out on load. `areas` maps a signal slot to
 * what it was spent on; `segs` maps a slot to the id of the block it belongs
 * to, so adjacent blocks stay separate; `notes` maps a block id to optional
 * details beyond its label. Each person only ever writes their own keys.
 *
 * Tasks are one running list per person, not per day: `tasks:<store>`,
 * holding { items: [{ id, text, due, done, doneAt, createdAt, group }],
 * groups: [{ id, name, parent, collapsed }], migrated, areas: [{ name, uses }] }.
 * Only the owner writes their list, so the whole list is replaced on save.
 *
 * Friends are mutual: a request sits in the other person's `incoming` until
 * they accept. You can read a friend's scored hours, never write them; plans
 * (schedule blocks, task lists) stay private to their owner.
 *
 * Sessions are an HMAC-signed cookie (SESSION_SECRET, set with
 * `wrangler pages secret put SESSION_SECRET`); it never lives in this repo.
 * Passwords are PBKDF2-SHA256 with a per-user salt.
 */

const MAX_BLOCKS = 80;
const MAX_TEXT = 240;
const MAX_TASKS = 4000;
const MAX_REMINDERS = 400;
const MAX_GROUPS = 100;
const MAX_AREAS = 200;
const MAX_FRIENDS = 200;
const PBKDF2_ITER = 100000; // the most Workers allows
const SESSION_DAYS = 60;
const COOKIE = "sl_session";
// Store names already taken by the original accounts' data.
const RESERVED = ["nathan", "karan"];
const USERNAME = /^[a-z0-9_]{3,20}$/;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const str = (v, cap) => (typeof v === "string" ? v.slice(0, cap) : "");

/* ---------------- crypto ---------------- */

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

async function hashPassword(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
  return b64(bits);
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

async function makeSession(env, user) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const body = b64url(JSON.stringify({ u: user.username, v: user.pwv, exp }));
  const sig = await hmac(env.SESSION_SECRET, body);
  return `${body}.${b64url(sig)}`;
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/api; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function readCookie(request) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === COOKIE) return part.slice(i + 1);
  }
  return "";
}

/* The signed-in user's record, or null. */
async function currentUser(request, env) {
  const token = readCookie(request);
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const want = b64url(await hmac(env.SESSION_SECRET, body));
  if (!sameString(token.slice(dot + 1), want)) return null;
  let claim;
  try {
    claim = JSON.parse(unb64url(body));
  } catch {
    return null;
  }
  if (!claim || typeof claim.u !== "string" || !(claim.exp > Date.now())) return null;
  const user = await getUser(env, claim.u);
  if (!user || user.pwv !== claim.v) return null;
  return user;
}

/* ---------------- users ---------------- */

const getUser = (env, name) => (USERNAME.test(name || "") ? env.LEDGER.get(`user:${name}`, "json") : null);
const putUser = (env, user) => env.LEDGER.put(`user:${user.username}`, JSON.stringify(user));

async function getSocial(env, name) {
  const s = (await env.LEDGER.get(`social:${name}`, "json")) || {};
  return { friends: s.friends || [], incoming: s.incoming || [], outgoing: s.outgoing || [] };
}
const putSocial = (env, name, s) => env.LEDGER.put(`social:${name}`, JSON.stringify(s));

const publicMe = (user, social) => ({ username: user.username, ...social });

async function readBody(request) {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? b : {};
  } catch {
    return null;
  }
}

function checkPassword(p) {
  if (typeof p !== "string" || p.length < 8) return "password_too_short";
  if (p.length > 200) return "password_too_long";
  return "";
}

async function register(request, env) {
  const body = await readBody(request);
  if (!body) return json({ error: "bad_json" }, 400);
  const username = str(body.username, 40).trim().toLowerCase();
  if (!USERNAME.test(username)) return json({ error: "bad_username" }, 400);
  if (RESERVED.includes(username)) return json({ error: "username_taken" }, 409);
  const bad = checkPassword(body.password);
  if (bad) return json({ error: bad }, 400);
  if (await env.LEDGER.get(`user:${username}`)) return json({ error: "username_taken" }, 409);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const user = {
    username,
    store: username,
    salt: b64(salt),
    hash: await hashPassword(body.password, salt, PBKDF2_ITER),
    iter: PBKDF2_ITER,
    pwv: 1,
    createdAt: new Date().toISOString(),
  };
  await putUser(env, user);
  await env.LEDGER.put(`months:${user.store}`, "[]");
  return json({ me: publicMe(user, await getSocial(env, username)) }, 200, { "set-cookie": sessionCookie(await makeSession(env, user), SESSION_DAYS * 86400) });
}

async function login(request, env) {
  const body = await readBody(request);
  if (!body) return json({ error: "bad_json" }, 400);
  const username = str(body.username, 40).trim().toLowerCase();
  const failKey = `fail:${username}`;
  const fails = Number(await env.LEDGER.get(failKey)) || 0;
  if (fails >= 10) return json({ error: "too_many_attempts" }, 429);
  const user = await getUser(env, username);
  const ok = user && typeof body.password === "string" &&
    sameString(await hashPassword(body.password, unb64(user.salt), user.iter), user.hash);
  if (!ok) {
    await env.LEDGER.put(failKey, String(fails + 1), { expirationTtl: 900 });
    return json({ error: "bad_login" }, 401);
  }
  if (fails) await env.LEDGER.delete(failKey);
  return json({ me: publicMe(user, await getSocial(env, username)) }, 200, { "set-cookie": sessionCookie(await makeSession(env, user), SESSION_DAYS * 86400) });
}

async function changePassword(request, env, user) {
  const body = await readBody(request);
  if (!body) return json({ error: "bad_json" }, 400);
  if (typeof body.current !== "string" ||
    !sameString(await hashPassword(body.current, unb64(user.salt), user.iter), user.hash)) {
    return json({ error: "bad_current" }, 403);
  }
  const bad = checkPassword(body.next);
  if (bad) return json({ error: bad }, 400);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  user.salt = b64(salt);
  user.hash = await hashPassword(body.next, salt, PBKDF2_ITER);
  user.iter = PBKDF2_ITER;
  user.pwv = (user.pwv || 0) + 1;
  await putUser(env, user);
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(await makeSession(env, user), SESSION_DAYS * 86400) });
}

/* ---------------- friends ---------------- */

const without = (list, name) => (list || []).filter((n) => n !== name);
const withName = (list, name) => ((list || []).includes(name) ? list : [...(list || []), name].slice(0, MAX_FRIENDS));

async function friends(request, env, me) {
  const body = await readBody(request);
  if (!body) return json({ error: "bad_json" }, 400);
  const action = body.action;
  const name = str(body.username, 40).trim().toLowerCase();
  if (name === me.username) return json({ error: "thats_you" }, 400);
  if (!(await getUser(env, name))) return json({ error: "no_such_user" }, 404);
  const [mine, them] = await Promise.all([getSocial(env, me.username), getSocial(env, name)]);
  const done = () => json({ me: publicMe(me, mine) });

  const link = () => {
    mine.friends = withName(mine.friends, name);
    them.friends = withName(them.friends, me.username);
    mine.incoming = without(mine.incoming, name);
    mine.outgoing = without(mine.outgoing, name);
    them.incoming = without(them.incoming, me.username);
    them.outgoing = without(them.outgoing, me.username);
  };

  if (action === "request") {
    if (mine.friends.includes(name)) return done();
    // They already asked you: asking back is the same as accepting.
    if (mine.incoming.includes(name)) link();
    else {
      mine.outgoing = withName(mine.outgoing, name);
      them.incoming = withName(them.incoming, me.username);
    }
  } else if (action === "accept") {
    if (!mine.incoming.includes(name)) return json({ error: "no_request" }, 400);
    link();
  } else if (action === "decline") {
    mine.incoming = without(mine.incoming, name);
    them.outgoing = without(them.outgoing, me.username);
  } else if (action === "cancel") {
    mine.outgoing = without(mine.outgoing, name);
    them.incoming = without(them.incoming, me.username);
  } else if (action === "remove") {
    mine.friends = without(mine.friends, name);
    them.friends = without(them.friends, me.username);
  } else {
    return json({ error: "bad_action" }, 400);
  }
  await Promise.all([putSocial(env, me.username, mine), putSocial(env, name, them)]);
  return done();
}

/* ---------------- ledger ---------------- */

function cleanBlocks(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_BLOCKS)
    .map((b) => ({ t: str(b && b.t, MAX_TEXT), w: str(b && b.w, MAX_TEXT) }))
    .filter((b) => b.t || b.w);
}

function cleanHours(v) {
  const out = {};
  if (!v || typeof v !== "object") return out;
  // Keys are slots, "H:MM" with H 0-23 and MM a multiple of 5.
  for (const k of Object.keys(v)) {
    const m = /^(\d{1,2}):([0-5][05])$/.exec(k);
    if (!m || Number(m[1]) > 23) continue;
    if (v[k] === "s" || v[k] === "n") out[k] = v[k];
  }
  return out;
}

// Slot -> area name, kept on any scored slot (signal or noise).
function cleanSlotAreas(v, hours) {
  const out = {};
  if (!v || typeof v !== "object") return out;
  for (const k of Object.keys(v)) {
    const n = str(v[k], 60).trim();
    if (n && (hours[k] === "s" || hours[k] === "n")) out[k] = n;
  }
  return out;
}

function cleanSegs(v, hours) {
  const out = {};
  if (!v || typeof v !== "object") return out;
  for (const k of Object.keys(v)) {
    if (hours[k] && typeof v[k] === "string" && /^[a-z0-9]{1,12}$/.test(v[k])) out[k] = v[k];
  }
  return out;
}

function cleanNotes(v, segs) {
  const out = {};
  if (!v || typeof v !== "object") return out;
  const live = new Set(Object.values(segs));
  for (const id of Object.keys(v)) {
    const t = str(v[id], 200);
    if (live.has(id) && t.trim()) out[id] = t;
  }
  return out;
}

function cleanAreaList(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const a of v.slice(0, MAX_AREAS)) {
    const name = str(a && a.name, 60).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, uses: Math.max(0, Math.floor(Number(a.uses) || 0)) });
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
      group: str(t && t.group, 40),
    }))
    .filter((t) => t.id && t.text);
}

function cleanGroups(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_GROUPS)
    .map((g) => ({
      id: str(g && g.id, 40),
      name: str(g && g.name, 80),
      parent: str(g && g.parent, 40),
      collapsed: !!(g && g.collapsed),
    }))
    .filter((g) => g.id);
}

/* The months with a ledger doc. Without an index yet, find them by listing. */
async function monthsOf(env, store) {
  const known = await env.LEDGER.get(`months:${store}`, "json");
  if (Array.isArray(known)) return known;
  const out = [];
  let cursor;
  do {
    const page = await env.LEDGER.list({ prefix: `ledger:${store}:`, cursor });
    for (const k of page.keys) out.push(k.name.slice(`ledger:${store}:`.length));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

/* One person's days and task list, keyed by their username. For a friend
   (`own` false) the plan is left out: no schedule, no task text, no list. */
async function readPerson(env, user, entries, tasks, own) {
  const months = await monthsOf(env, user.store);
  const [list, ...docs] = await Promise.all([
    own ? env.LEDGER.get(`tasks:${user.store}`, "json") : null,
    ...months.map((m) => env.LEDGER.get(`ledger:${user.store}:${m}`, "json")),
  ]);
  if (list) tasks[user.username] = list;
  docs.forEach((doc) => {
    for (const date of Object.keys(doc || {})) {
      const e = doc[date] || {};
      entries[`${date}__${user.username}`] = {
        date,
        person: user.username,
        step: e.step,
        blocks: own ? e.blocks || [] : [],
        tasks: own ? e.tasks || "" : "",
        hours: e.hours || {},
        areas: e.areas || {},
        segs: e.segs || {},
        notes: e.notes || {},
      };
    }
  });
}

/* Your ledger, plus one friend's when ?with=<friend> names a mutual friend. */
async function readLedger(request, env, me) {
  const entries = {};
  const tasks = {};
  const reads = [readPerson(env, me, entries, tasks, true)];
  const name = (new URL(request.url).searchParams.get("with") || "").toLowerCase();
  const mine = await getSocial(env, me.username);
  let friend = "";
  if (name && mine.friends.includes(name)) {
    const [them, theirs] = await Promise.all([getUser(env, name), getSocial(env, name)]);
    if (them && theirs.friends.includes(me.username)) {
      friend = name;
      reads.push(readPerson(env, them, entries, tasks, false));
    }
  }
  await Promise.all(reads);
  return json({ me: publicMe(me, mine), friend, entries, tasks });
}

async function writeLedger(request, env, me) {
  const body = await readBody(request);
  if (!body) return json({ error: "bad_json" }, 400);
  const items = Array.isArray(body.entries) ? body.entries : [];
  const lists = Array.isArray(body.tasks) ? body.tasks : [];
  if (!items.length && !lists.length) return json({ error: "no_entries" }, 400);
  if (items.length > 120) return json({ error: "too_many_entries" }, 400);
  // You only ever write your own days and list.
  for (const it of [...items, ...lists]) {
    if (!it || it.person !== me.username) return json({ error: "not_yours" }, 403);
  }
  if (lists.length > 1) return json({ error: "too_many_lists" }, 400);

  const groups = new Map();
  for (const it of items) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || "")) return json({ error: "bad_date" }, 400);
    const month = it.date.slice(0, 7);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(it);
  }

  // Record new months on the account first, so a month is never written
  // without being findable afterwards.
  const known = new Set(await monthsOf(env, me.store));
  const fresh = [...groups.keys()].filter((m) => !known.has(m));
  if (fresh.length) await env.LEDGER.put(`months:${me.store}`, JSON.stringify([...known, ...fresh].sort()));

  for (const [month, list] of groups) {
    const name = `ledger:${me.store}:${month}`;
    const doc = (await env.LEDGER.get(name, "json")) || {};
    const stamp = new Date().toISOString();
    for (const it of list) {
      const hours = cleanHours(it.hours);
      const segs = cleanSegs(it.segs, hours);
      doc[it.date] = {
        ...(it.step === 5 ? { step: 5 } : {}),
        blocks: cleanBlocks(it.blocks),
        tasks: str(it.tasks, MAX_TASKS),
        hours,
        areas: cleanSlotAreas(it.areas, hours),
        segs,
        notes: cleanNotes(it.notes, segs),
        updatedAt: stamp,
      };
    }
    await env.LEDGER.put(name, JSON.stringify(doc));
  }
  for (const l of lists) {
    await env.LEDGER.put(
      `tasks:${me.store}`,
      JSON.stringify({ items: cleanReminders(l.items), groups: cleanGroups(l.groups), migrated: !!l.migrated, areas: cleanAreaList(l.areas), updatedAt: new Date().toISOString() }),
    );
  }
  return json({ ok: true, months: groups.size, lists: lists.length });
}

/* ---------------- routing ---------------- */

export async function onRequest({ request, env, params }) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!env.LEDGER) return json({ error: "kv_unbound" }, 503);
  if (!env.SESSION_SECRET) return json({ error: "no_session_secret" }, 503);
  const route = (params.path || []).join("/");
  const method = request.method;
  // Writes must be JSON, which a cross-site form can't send.
  if (method === "POST" && !(request.headers.get("content-type") || "").startsWith("application/json")) {
    return json({ error: "json_only" }, 415);
  }

  if (route === "register" && method === "POST") return register(request, env);
  if (route === "login" && method === "POST") return login(request, env);
  if (route === "logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });

  const me = await currentUser(request, env);
  if (!me) return json({ error: "unauthorized" }, 401);
  if (route === "me" && method === "GET") return json({ me: publicMe(me, await getSocial(env, me.username)) });
  if (route === "password" && method === "POST") return changePassword(request, env, me);
  if (route === "friends" && method === "POST") return friends(request, env, me);
  if (route === "ledger" && method === "GET") return readLedger(request, env, me);
  if (route === "ledger" && method === "POST") return writeLedger(request, env, me);
  return json({ error: "not_found" }, 404);
}
