// ─────────────────────────────────────────────────────────────
//  Kitty API Worker  rev: e817c6e
//  Bindings:
//    DB  → D1  (kittydb)
//    R2  → R2  (kitty-assets)
//    KV  → KV  (kitty-sessions)
// ─────────────────────────────────────────────────────────────

const REV = 'e817c6e';
const SESSION_TTL  = 60 * 60 * 24 * 30;   // 30 days in seconds
const COOKIE_NAME  = 'kitty_sid';

// ── CORS ────────────────────────────────────────────────────
function corsHeaders(req) {
  const origin = req.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin':      origin,
    'Access-Control-Allow-Methods':     'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type, Authorization, X-Invite-Token, Cookie',
    'Access-Control-Allow-Credentials': 'true',
  };
}

function json(data, status = 200, extraHeaders = {}, req) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req||{headers:{get:()=>'*'}}) , ...extraHeaders },
  });
}
function err(msg, status = 400, req) { return json({ error: msg }, status, {}, req); }

// ── Cookie helpers ───────────────────────────────────────────
function getCookie(req, name) {
  const h = req.headers.get('Cookie') || '';
  const match = h.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=')[1]) : null;
}

function setCookieHeader(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=None; Secure`;
}

// ── Session helpers ──────────────────────────────────────────
async function getSession(env, sid) {
  if (!env.KV || !sid) return null;
  try {
    const raw = await env.KV.get('session:' + sid);
    return raw ? JSON.parse(raw) : null;
  } catch(e) { return null; }
}

async function saveSession(env, sid, data) {
  if (!env.KV) return;
  try {
    await env.KV.put('session:' + sid, JSON.stringify(data), { expirationTtl: SESSION_TTL });
  } catch(e) { console.error('session save error', e); }
}

async function getOrCreateSession(req, env) {
  const sid = getCookie(req, COOKIE_NAME);
  if (sid) {
    const sess = await getSession(env, sid);
    if (sess) {
      // Refresh TTL on activity
      sess.lastSeen = new Date().toISOString();
      await saveSession(env, sid, sess);
      return { sid, sess, isNew: false };
    }
  }
  // Create new session
  const newSid  = crypto.randomUUID();
  const newSess = { tripTokens: {}, whoByTrip: {}, created: new Date().toISOString(), lastSeen: new Date().toISOString() };
  await saveSession(env, newSid, newSess);
  return { sid: newSid, sess: newSess, isNew: true };
}

// ── Invite-token auth ────────────────────────────────────────
async function validateAccess(req, env, tripId, sess) {
  // Master secret bypass
  const hdr = req.headers.get('X-Invite-Token') || '';
  if (env.KITTY_SECRET && hdr === 'master:' + env.KITTY_SECRET) return true;

  // Session already has a valid token for this trip
  const sessionToken = sess?.tripTokens?.[tripId];
  if (sessionToken && env.KV) {
    try {
      const stored = await env.KV.get(`invite:${tripId}:${sessionToken}`);
      if (stored !== null) return true;
    } catch(e) {}
  }

  // Fallback: X-Invite-Token header
  if (hdr && env.KV) {
    try {
      const stored = await env.KV.get(`invite:${tripId}:${hdr}`);
      if (stored !== null) return true;
    } catch(e) {}
  }

  // No KV → bootstrap
  if (!env.KV) return 'bootstrap';

  // No tokens exist for this trip yet → bootstrap
  try {
    const { keys } = await env.KV.list({ prefix: `invite:${tripId}:` });
    if (keys.length === 0) return 'bootstrap';
  } catch(e) { return true; }

  return false;
}

async function createInviteToken(env, tripId, label) {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  if (env.KV) {
    try {
      await env.KV.put(`invite:${tripId}:${token}`,
        JSON.stringify({ tripId, label, created: new Date().toISOString() }));
    } catch(e) { console.error('KV put error', e); }
  }
  return token;
}

async function listInviteTokens(env, tripId) {
  if (!env.KV) return [];
  try {
    const { keys } = await env.KV.list({ prefix: `invite:${tripId}:` });
    return await Promise.all(keys.map(async k => {
      const val = await env.KV.get(k.name);
      return { token: k.name.split(':')[2], ...JSON.parse(val||'{}') };
    }));
  } catch(e) { return []; }
}

// ── R2 helpers ───────────────────────────────────────────────
async function uploadPhoto(env, key, body, ct) {
  if (!env.R2) throw new Error('R2 not configured');
  await env.R2.put(key, body, { httpMetadata: { contentType: ct } });
  return key;
}
async function deletePhoto(env, key) {
  if (key && env.R2) await env.R2.delete(key).catch(()=>{});
}
// ── AWS SigV4 helpers for R2 presigned URLs ───────────────────
// R2 is S3-compatible: endpoint is https://<accountId>.r2.cloudflarestorage.com
async function hmacSHA256(key, data) {
  const k = typeof key === 'string'
    ? new TextEncoder().encode(key)
    : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey,
    typeof data === 'string' ? new TextEncoder().encode(data) : data));
}

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256',
    typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

function toHex(buf) {
  return Array.from(buf).map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function getSigningKey(secret, date, region, service) {
  const kDate    = await hmacSHA256('AWS4' + secret, date);
  const kRegion  = await hmacSHA256(kDate,  region);
  const kService = await hmacSHA256(kRegion, service);
  return        await hmacSHA256(kService, 'aws4_request');
}

async function createPresignedUrl(env, key, expiresIn = 300) {
  const accountId  = env.R2_ACCOUNT_ID;
  const accessKey  = env.R2_ACCESS_KEY_ID;
  const secretKey  = env.R2_SECRET_ACCESS_KEY;
  const bucket     = 'kitty-assets';
  const region     = 'auto';
  const service    = 's3';

  if (!accountId || !accessKey || !secretKey) {
    throw new Error('R2 credentials not configured. Run: npx wrangler secret put R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY');
  }

  const host     = `${accountId}.r2.cloudflarestorage.com`;
  const endpoint = `https://${host}/${bucket}/${key}`;
  const now      = new Date();
  const amzDate  = now.toISOString().replace(/[:\-]|\.\d{3}/g,'').slice(0,15)+'Z';
  const dateStamp = amzDate.slice(0,8);

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential      = `${accessKey}/${credentialScope}`;

  const params = new URLSearchParams({
    'X-Amz-Algorithm':     'AWS4-HMAC-SHA256',
    'X-Amz-Credential':    credential,
    'X-Amz-Date':          amzDate,
    'X-Amz-Expires':       String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  });
  // Sort params for canonical query string
  const sortedParams = new URLSearchParams([...params.entries()].sort());

  const canonicalRequest = [
    'PUT',
    '/' + bucket + '/' + key,
    sortedParams.toString(),
    'host:' + host + '\n',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSigningKey(secretKey, dateStamp, region, service);
  const signature  = toHex(await hmacSHA256(signingKey, stringToSign));

  sortedParams.set('X-Amz-Signature', signature);
  return `https://${host}/${bucket}/${key}?${sortedParams.toString()}`;
}



// ── Route parser ─────────────────────────────────────────────
function parseRoute(url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', resource, id?, sub?, subId?]
  return { resource: parts[1], id: parts[2], sub: parts[3], subId: parts[4] };
}


// ── Short join code helpers ───────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let code = '';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  arr.forEach(b => code += chars[b % chars.length]);
  return code;
}

async function uniqueCode(env) {
  for (let attempts = 0; attempts < 10; attempts++) {
    const code = generateCode();
    const existing = await env.DB.prepare('SELECT id FROM trips WHERE code=?').bind(code).first();
    if (!existing) return code;
  }
  throw new Error('Could not generate unique code');
}

// ─────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(req) });

    const url    = new URL(req.url);
    const { resource, id, sub, subId } = parseRoute(url);
    const method = req.method;

    // Get or create session for every request
    const { sid, sess, isNew } = await getOrCreateSession(req, env);
    const cookieHeader = isNew ? { 'Set-Cookie': setCookieHeader(COOKIE_NAME, sid, SESSION_TTL) } : {};

    // Helper: respond with json + always attach cookie if new
    const respond = (data, status=200, extra={}) =>
      json(data, status, { ...cookieHeader, ...extra }, req);

    try {

      // ── SESSION ────────────────────────────────────────────
      if (resource === 'session') {

        // GET session — returns accessible trip list + who-am-I per trip
        if (method === 'GET') {
          // Gather trips this session has tokens for
          const tripIds = Object.keys(sess.tripTokens || {});
          let trips = [];
          if (tripIds.length > 0) {
            const placeholders = tripIds.map(()=>'?').join(',');
            const { results } = await env.DB.prepare(
              `SELECT id, name, start_date, end_date, icon, code, cover_photo,
                (SELECT COUNT(*) FROM expenses WHERE trip_id=t.id) as expense_count,
                (SELECT COUNT(*) FROM people WHERE trip_id=t.id) as people_count,
                (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE trip_id=t.id) as total_amount
               FROM trips t WHERE id IN (${placeholders}) ORDER BY created_at DESC`
            ).bind(...tripIds).all();
            trips = results;
          }
          return respond({
            sid,
            whoByTrip:   sess.whoByTrip   || {},
            tripTokens:  sess.tripTokens  || {},
            trips,
          });
        }

        // PATCH session — update whoByTrip or register a token
        // Note: we do NOT validate the token here — it gets validated
        // on every actual trip access via validateAccess(). The session
        // is just a convenience store so we don't lose tokens on refresh.
        if (method === 'PATCH') {
          const b = await req.json();
          if (b.whoByTrip) {
            sess.whoByTrip = { ...sess.whoByTrip, ...b.whoByTrip };
          }
          if (b.tripId && b.token) {
            sess.tripTokens = { ...sess.tripTokens, [b.tripId]: b.token };
          }
          sess.lastSeen = new Date().toISOString();
          await saveSession(env, sid, sess);
          return respond({ ok: true });
        }

        // DELETE session — logout
        if (method === 'DELETE') {
          if (env.KV) await env.KV.delete('session:' + sid).catch(()=>{});
          return new Response(JSON.stringify({ ok: true }), {
            headers: {
              'Content-Type': 'application/json',
              'Set-Cookie': setCookieHeader(COOKIE_NAME, '', 0),
              ...corsHeaders(req),
            },
          });
        }
      }

      // ── VERSION ────────────────────────────────────────────
      if (resource === 'version') return respond({ rev: REV, ok: true });


      // ── JOIN by short code ─────────────────────────────────
      if (resource === 'join' && id) {
        const code = id.toUpperCase();
        const trip = await env.DB.prepare(
          `SELECT id, name, start_date, end_date, icon FROM trips WHERE code=?`
        ).bind(code).first();
        if (!trip) return respond({ error: 'Trip not found — check your code' }, 404);

        // Issue an invite token and store in session
        const token = await createInviteToken(env, trip.id, 'join:'+code);
        sess.tripTokens = { ...sess.tripTokens, [trip.id]: token };
        await saveSession(env, sid, sess);

        return respond({ ok: true, tripId: trip.id, token, trip });
      }

      // ── TRIPS ──────────────────────────────────────────────
      if (resource === 'trips') {

        // LIST — return trips from session
        if (method === 'GET' && !id) {
          const tripIds = Object.keys(sess.tripTokens || {});
          if (!tripIds.length) return respond([]);
          const placeholders = tripIds.map(()=>'?').join(',');
          const { results } = await env.DB.prepare(
            `SELECT id, name, start_date, end_date, icon, code, cover_photo,
              (SELECT COUNT(*) FROM expenses WHERE trip_id=t.id) as expense_count,
              (SELECT COUNT(*) FROM people WHERE trip_id=t.id) as people_count,
              (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE trip_id=t.id) as total_amount
             FROM trips t WHERE id IN (${placeholders}) ORDER BY created_at DESC`
          ).bind(...tripIds).all();
          return respond(results);
        }

        // GET single trip
        if (method === 'GET' && id && !sub) {
          const authed = await validateAccess(req, env, id, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);

          let bootstrapToken = null;
          if (authed === 'bootstrap') {
            bootstrapToken = await createInviteToken(env, id, 'creator');
            // Save into session
            sess.tripTokens = { ...sess.tripTokens, [id]: bootstrapToken };
            await saveSession(env, sid, sess);
          }

          const trip = await env.DB.prepare(`SELECT * FROM trips WHERE id=?`).bind(id).first();
          if (!trip) return respond({ error: 'Trip not found' }, 404);

          const { results: expenses }    = await env.DB.prepare(`SELECT * FROM expenses WHERE trip_id=? ORDER BY date ASC, created_at ASC`).bind(id).all();
          const { results: people }      = await env.DB.prepare(`SELECT * FROM people WHERE trip_id=? ORDER BY created_at ASC`).bind(id).all();
          const { results: history }     = await env.DB.prepare(`SELECT * FROM history WHERE trip_id=? ORDER BY ts ASC`).bind(id).all();
          const { results: settlements } = await env.DB.prepare(`SELECT * FROM settlements WHERE trip_id=?`).bind(id).all();

          expenses.forEach(e => {
            e.splitBetween    = JSON.parse(e.split_between   || '[]');
            e.paidSettlements = JSON.parse(e.paid_settlements || '{}');
            e.splitType       = e.split_type || 'even';
            e.shares          = e.shares ? JSON.parse(e.shares) : null;
            if (e.photo) e.photoUrl = `${url.origin}/api/photos/${e.photo}`;
          });
          if (trip.cover_photo) trip.coverPhotoUrl = `${url.origin}/api/photos/${trip.cover_photo}`;

          return respond({
            ...trip,
            people:          people.map(p => p.name),
            expenses,
            history,
            settledPayments: settlements,
            ...(bootstrapToken ? { bootstrapToken } : {}),
          });
        }

        // CREATE
        if (method === 'POST' && !id) {
          const b      = await req.json();
          const tripId = b.id || crypto.randomUUID();
          const code = await uniqueCode(env);
          await env.DB.prepare(
            `INSERT INTO trips (id,name,start_date,end_date,icon,cover_photo,code,created_at) VALUES (?,?,?,?,?,?,?,?)`
          ).bind(tripId, b.name, b.startDate||null, b.endDate||null, b.icon||null, null, code, new Date().toISOString()).run();

          for (const name of (b.people||[])) {
            await env.DB.prepare(`INSERT OR IGNORE INTO people (id,trip_id,name,created_at) VALUES (?,?,?,?)`)
              .bind(crypto.randomUUID(), tripId, name, new Date().toISOString()).run();
          }

          const token = await createInviteToken(env, tripId, 'creator');
          // Store token in session immediately
          sess.tripTokens = { ...sess.tripTokens, [tripId]: token };
          await saveSession(env, sid, sess);

          return respond({ ok: true, tripId, token, code });
        }

        // UPDATE
        if (method === 'PUT' && id && !sub) {
          const authed = await validateAccess(req, env, id, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          const b = await req.json();
          await env.DB.prepare(
            `UPDATE trips SET name=?,start_date=?,end_date=?,icon=?,cover_photo=? WHERE id=?`
          ).bind(b.name, b.startDate||null, b.endDate||null, b.icon||null, b.coverPhoto||null, id).run();
          return respond({ ok: true });
        }

        // DELETE
        if (method === 'DELETE' && id && !sub) {
          const authed = await validateAccess(req, env, id, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          const { results: exps } = await env.DB.prepare(`SELECT photo FROM expenses WHERE trip_id=? AND photo IS NOT NULL`).bind(id).all();
          const trip = await env.DB.prepare(`SELECT cover_photo FROM trips WHERE id=?`).bind(id).first();
          await Promise.all([ ...exps.map(e => deletePhoto(env, e.photo)), deletePhoto(env, trip?.cover_photo) ]);
          if (env.KV) {
            const { keys } = await env.KV.list({ prefix: `invite:${id}:` });
            await Promise.all(keys.map(k => env.KV.delete(k.name)));
          }
          await env.DB.prepare(`DELETE FROM trips WHERE id=?`).bind(id).run();
          // Remove from session
          delete sess.tripTokens[id];
          delete sess.whoByTrip[id];
          await saveSession(env, sid, sess);
          return respond({ ok: true });
        }

        // ── PEOPLE ──────────────────────────────────────────
        if (id && sub === 'people') {
          const authed = await validateAccess(req, env, id, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          if (method === 'POST') {
            const { name } = await req.json();
            await env.DB.prepare(`INSERT OR IGNORE INTO people (id,trip_id,name,created_at) VALUES (?,?,?,?)`)
              .bind(crypto.randomUUID(), id, name, new Date().toISOString()).run();
            return respond({ ok: true });
          }
          if (method === 'DELETE') {
            const { name } = await req.json();
            await env.DB.prepare(`DELETE FROM people WHERE trip_id=? AND name=?`).bind(id, name).run();
            return respond({ ok: true });
          }
        }

        // ── INVITES ─────────────────────────────────────────
        if (id && sub === 'invites') {
          const authed = await validateAccess(req, env, id, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          if (method === 'GET')  return respond(await listInviteTokens(env, id));
          if (method === 'POST') {
            const { label } = await req.json().catch(()=>({}));
            const token = await createInviteToken(env, id, label||'invite');
            return respond({ token });
          }
          if (method === 'DELETE' && subId) {
            if (env.KV) await env.KV.delete(`invite:${id}:${subId}`);
            return respond({ ok: true });
          }
        }
      }

      // ── EXPENSES ───────────────────────────────────────────
      if (resource === 'expenses') {
        if (method === 'POST' && !id) {
          const b = await req.json();
          const authed = await validateAccess(req, env, b.tripId, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          await env.DB.prepare(
            `INSERT INTO expenses (id,trip_id,desc,amount,paid_by,date,note,category,split_between,photo,paid_settlements,split_type,shares,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(b.id, b.tripId, b.desc, b.amount, b.paidBy, b.date||null, b.note||null,
                 b.category||'other', JSON.stringify(b.splitBetween||[]),
                 (b.photoKey||(b.photo&&typeof b.photo==='string'&&!b.photo.startsWith('data:')?b.photo:null))||null, JSON.stringify(b.paidSettlements||{}),
                 b.splitType||'even', b.shares ? JSON.stringify(b.shares) : null,
                 new Date().toISOString()).run();
          return respond({ ok: true });
        }
        if (method === 'PUT' && id) {
          const b = await req.json();
          const authed = await validateAccess(req, env, b.tripId, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          await env.DB.prepare(
            `UPDATE expenses SET desc=?,amount=?,paid_by=?,date=?,note=?,category=?,split_between=?,photo=?,paid_settlements=?,split_type=?,shares=? WHERE id=?`
          ).bind(b.desc, b.amount, b.paidBy, b.date||null, b.note||null, b.category||'other',
                 JSON.stringify(b.splitBetween||[]), (b.photoKey||(b.photo&&typeof b.photo==='string'&&!b.photo.startsWith('data:')?b.photo:null))||null,
                 JSON.stringify(b.paidSettlements||{}),
                 b.splitType||'even', b.shares ? JSON.stringify(b.shares) : null,
                 id).run();
          return respond({ ok: true });
        }
        if (method === 'DELETE' && id) {
          const exp = await env.DB.prepare(`SELECT trip_id, photo FROM expenses WHERE id=?`).bind(id).first();
          if (!exp) return respond({ error: 'Not found' }, 404);
          const authed = await validateAccess(req, env, exp.trip_id, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          await deletePhoto(env, exp.photo);
          await env.DB.prepare(`DELETE FROM expenses WHERE id=?`).bind(id).run();
          return respond({ ok: true });
        }
      }

      // ── PHOTOS ─────────────────────────────────────────────
      if (resource === 'photos') {

        // POST /api/photos/sign?tripId=xxx&ext=jpg — get a presigned upload URL
        if (method === 'POST' && id === 'sign') {
          const tripId = url.searchParams.get('tripId');
          const ext    = (url.searchParams.get('ext') || 'jpg').replace(/[^a-z0-9]/gi,'');
          const authed = await validateAccess(req, env, tripId, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          const key = `photos/${tripId}/${crypto.randomUUID()}.${ext}`;
          try {
            const presignedUrl = await createPresignedUrl(env, key, 300);
            return respond({ key, url: presignedUrl });
          } catch(e) {
            console.error('Presign error:', e.message);
            return respond({ error: e.message }, 503);
          }
        }

        // POST /api/photos?tripId=xxx — direct upload via Worker (fallback if no S3 creds)
        if (method === 'POST') {
          const tripId = url.searchParams.get('tripId');
          const authed = await validateAccess(req, env, tripId, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          if (!env.R2) return respond({ error: 'R2 not configured' }, 503);
          const ct  = req.headers.get('Content-Type') || 'image/jpeg';
          const ext = ct.split('/')[1]?.split(';')[0] || 'jpg';
          const key = `photos/${tripId}/${crypto.randomUUID()}.${ext}`;
          try {
            await uploadPhoto(env, key, req.body, ct);
          } catch(e) {
            return respond({ error: 'Upload failed: ' + e.message }, 500);
          }
          return respond({ key, url: `${url.origin}/api/photos/${key}` });
        }

        // GET /api/photos/<key> — serve photo from R2 (key may have slashes)
        if (method === 'GET') {
          if (!env.R2) return respond({ error: 'R2 not configured' }, 503);
          const key = url.pathname.replace(/^\/api\/photos\//, '');
          if (!key) return respond({ error: 'No key' }, 400);
          const obj = await env.R2.get(key);
          if (!obj) return respond({ error: 'Not found' }, 404);
          return new Response(obj.body, {
            headers: {
              'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
              'Cache-Control': 'public, max-age=31536000, immutable',
              ...corsHeaders(req),
            },
          });
        }

        // DELETE /api/photos/<key>?tripId=xxx
        if (method === 'DELETE') {
          const tripId = url.searchParams.get('tripId');
          const authed = await validateAccess(req, env, tripId, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          const key = url.pathname.replace(/^\/api\/photos\//, '');
          await deletePhoto(env, key);
          return respond({ ok: true });
        }
      }

      // ── HISTORY ────────────────────────────────────────────
      if (resource === 'history' && method === 'POST') {
        const b = await req.json();
        const authed = await validateAccess(req, env, b.tripId, sess);
        if (!authed) return respond({ error: 'Unauthorized' }, 401);
        await env.DB.prepare(
          `INSERT INTO history (id,trip_id,ts,who,action,desc,amount,changes) VALUES (?,?,?,?,?,?,?,?)`
        ).bind(crypto.randomUUID(), b.tripId, b.ts, b.who,
               b.action, b.desc, b.amount||null, b.changes||null).run();
        return respond({ ok: true });
      }

      // ── SETTLEMENTS ────────────────────────────────────────
      if (resource === 'settlements') {
        if (method === 'POST') {
          const b = await req.json();
          const authed = await validateAccess(req, env, b.tripId, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          await env.DB.prepare(
            `INSERT OR REPLACE INTO settlements (id,trip_id,from_person,to_person,amount,ts) VALUES (?,?,?,?,?,?)`
          ).bind(b.id, b.tripId, b.from, b.to, b.amt, b.ts).run();
          return respond({ ok: true });
        }
        if (method === 'DELETE' && id) {
          const tripId = url.searchParams.get('tripId');
          const authed = await validateAccess(req, env, tripId, sess);
          if (!authed) return respond({ error: 'Unauthorized' }, 401);
          await env.DB.prepare(`DELETE FROM settlements WHERE id=?`).bind(id).run();
          return respond({ ok: true });
        }
      }

      return respond({ error: 'Not found' }, 404);

    } catch(e) {
      console.error(e);
      return respond({ error: e.message }, 500);
    }
  }
};
