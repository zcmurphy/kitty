// ─────────────────────────────────────────────────────────────
//  Kitty API Worker  rev: a3f9c1
//  Bindings required in wrangler.toml:
//    DB  → D1 database (kittydb)
//    R2  → R2 bucket  (kitty-assets)
//    KV  → KV namespace (kitty-sessions)
// ─────────────────────────────────────────────────────────────

const REV = 'a3f9c1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Invite-Token',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
function err(msg, status = 400) { return json({ error: msg }, status); }

// ── Auth helpers ─────────────────────────────────────────────
async function validateToken(req, env, tripId) {
  const token = req.headers.get('X-Invite-Token') || '';
  if (!token) return false;
  const stored = await env.KV.get(`invite:${tripId}:${token}`);
  return stored !== null;
}

async function createInviteToken(env, tripId, label) {
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const payload = JSON.stringify({ tripId, label, created: new Date().toISOString() });
  // no expiry — permanent until revoked
  await env.KV.put(`invite:${tripId}:${token}`, payload);
  return token;
}

async function listInviteTokens(env, tripId) {
  const { keys } = await env.KV.list({ prefix: `invite:${tripId}:` });
  const tokens = await Promise.all(keys.map(async k => {
    const val = await env.KV.get(k.name);
    return { token: k.name.split(':')[2], ...JSON.parse(val || '{}') };
  }));
  return tokens;
}

// ── R2 photo helpers ─────────────────────────────────────────
async function uploadPhoto(env, key, body, contentType) {
  await env.R2.put(key, body, { httpMetadata: { contentType } });
  return key;
}

async function deletePhoto(env, key) {
  if (key) await env.R2.delete(key).catch(() => {});
}

// ── parse route ──────────────────────────────────────────────
function parseRoute(url) {
  // /api/{resource}/{id}/{sub}/{subId}
  const parts = url.pathname.split('/').filter(Boolean);
  // parts[0] = 'api'
  return {
    resource: parts[1],
    id:       parts[2],
    sub:      parts[3],
    subId:    parts[4],
  };
}

// ─────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url  = new URL(req.url);
    const { resource, id, sub, subId } = parseRoute(url);
    const method = req.method;

    try {

      // ── VERSION ping ──────────────────────────────────────
      if (resource === 'version') return json({ rev: REV, ok: true });

      // ── TRIPS ─────────────────────────────────────────────
      if (resource === 'trips') {

        // LIST
        if (method === 'GET' && !id) {
          const token = req.headers.get('X-Invite-Token') || '';
          // Return only trips this token has access to
          // If no token, return all (for now — lock down per your auth needs)
          const { results } = await env.DB.prepare(
            `SELECT t.id, t.name, t.start_date, t.end_date, t.icon,
              (SELECT COUNT(*) FROM expenses WHERE trip_id=t.id) as expense_count
             FROM trips t ORDER BY created_at DESC`
          ).all();
          return json(results);
        }

        // GET single trip (requires valid token)
        if (method === 'GET' && id && !sub) {
          const authed = await validateToken(req, env, id);
          if (!authed) return err('Invalid or missing invite token', 401);

          const trip = await env.DB.prepare(`SELECT * FROM trips WHERE id=?`).bind(id).first();
          if (!trip) return err('Trip not found', 404);

          const { results: expenses }    = await env.DB.prepare(`SELECT * FROM expenses WHERE trip_id=? ORDER BY date ASC, created_at ASC`).bind(id).all();
          const { results: people }      = await env.DB.prepare(`SELECT * FROM people WHERE trip_id=? ORDER BY created_at ASC`).bind(id).all();
          const { results: history }     = await env.DB.prepare(`SELECT * FROM history WHERE trip_id=? ORDER BY ts ASC`).bind(id).all();
          const { results: settlements } = await env.DB.prepare(`SELECT * FROM settlements WHERE trip_id=?`).bind(id).all();

          expenses.forEach(e => {
            e.splitBetween    = JSON.parse(e.split_between   || '[]');
            e.paidSettlements = JSON.parse(e.paid_settlements || '{}');
            // photo field is now an R2 key — return a served URL
            if (e.photo) e.photoUrl = `${url.origin}/api/photos/${e.photo}`;
          });

          if (trip.cover_photo) trip.coverPhotoUrl = `${url.origin}/api/photos/${trip.cover_photo}`;

          return json({
            ...trip,
            people:         people.map(p => p.name),
            expenses,
            history,
            settledPayments: settlements,
          });
        }

        // CREATE
        if (method === 'POST' && !id) {
          const b = await req.json();
          const tripId = b.id || crypto.randomUUID();
          await env.DB.prepare(
            `INSERT INTO trips (id,name,start_date,end_date,icon,cover_photo,created_at)
             VALUES (?,?,?,?,?,?,?)`
          ).bind(tripId, b.name, b.startDate||null, b.endDate||null,
                 b.icon||null, null, new Date().toISOString()).run();

          for (const name of (b.people||[])) {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO people (id,trip_id,name,created_at) VALUES (?,?,?,?)`
            ).bind(crypto.randomUUID(), tripId, name, new Date().toISOString()).run();
          }

          // Auto-create a first invite token for the creator
          const token = await createInviteToken(env, tripId, 'creator');
          return json({ ok: true, tripId, token });
        }

        // UPDATE trip metadata (requires token)
        if (method === 'PUT' && id && !sub) {
          const authed = await validateToken(req, env, id);
          if (!authed) return err('Unauthorized', 401);
          const b = await req.json();
          await env.DB.prepare(
            `UPDATE trips SET name=?,start_date=?,end_date=?,icon=?,cover_photo=? WHERE id=?`
          ).bind(b.name, b.startDate||null, b.endDate||null,
                 b.icon||null, b.coverPhoto||null, id).run();
          return json({ ok: true });
        }

        // DELETE trip (requires token)
        if (method === 'DELETE' && id && !sub) {
          const authed = await validateToken(req, env, id);
          if (!authed) return err('Unauthorized', 401);
          // Clean up R2 photos
          const { results: exps } = await env.DB.prepare(`SELECT photo FROM expenses WHERE trip_id=? AND photo IS NOT NULL`).bind(id).all();
          const trip = await env.DB.prepare(`SELECT cover_photo FROM trips WHERE id=?`).bind(id).first();
          await Promise.all([
            ...exps.map(e => deletePhoto(env, e.photo)),
            deletePhoto(env, trip?.cover_photo),
          ]);
          // Clean up KV invite tokens
          const { keys } = await env.KV.list({ prefix: `invite:${id}:` });
          await Promise.all(keys.map(k => env.KV.delete(k.name)));
          // Delete from D1 (cascades)
          await env.DB.prepare(`DELETE FROM trips WHERE id=?`).bind(id).run();
          return json({ ok: true });
        }

        // ── PEOPLE sub ──────────────────────────────────────
        if (id && sub === 'people') {
          const authed = await validateToken(req, env, id);
          if (!authed) return err('Unauthorized', 401);
          if (method === 'POST') {
            const { name } = await req.json();
            await env.DB.prepare(`INSERT OR IGNORE INTO people (id,trip_id,name,created_at) VALUES (?,?,?,?)`)
              .bind(crypto.randomUUID(), id, name, new Date().toISOString()).run();
            return json({ ok: true });
          }
          if (method === 'DELETE') {
            const { name } = await req.json();
            await env.DB.prepare(`DELETE FROM people WHERE trip_id=? AND name=?`).bind(id, name).run();
            return json({ ok: true });
          }
        }

        // ── INVITES sub ─────────────────────────────────────
        if (id && sub === 'invites') {
          const authed = await validateToken(req, env, id);
          if (!authed) return err('Unauthorized', 401);

          // LIST invite tokens
          if (method === 'GET') {
            const tokens = await listInviteTokens(env, id);
            return json(tokens);
          }
          // CREATE new invite token
          if (method === 'POST') {
            const { label } = await req.json().catch(() => ({}));
            const token = await createInviteToken(env, id, label || 'invite');
            return json({ token });
          }
          // REVOKE a token  DELETE /api/trips/:id/invites/:token
          if (method === 'DELETE' && subId) {
            await env.KV.delete(`invite:${id}:${subId}`);
            return json({ ok: true });
          }
        }
      }

      // ── EXPENSES ──────────────────────────────────────────
      if (resource === 'expenses') {

        if (method === 'POST' && !id) {
          const b = await req.json();
          const authed = await validateToken(req, env, b.tripId);
          if (!authed) return err('Unauthorized', 401);
          await env.DB.prepare(
            `INSERT INTO expenses (id,trip_id,desc,amount,paid_by,date,note,category,split_between,photo,paid_settlements,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            b.id, b.tripId, b.desc, b.amount, b.paidBy, b.date||null,
            b.note||null, b.category||'other',
            JSON.stringify(b.splitBetween||[]),
            b.photoKey||null,
            JSON.stringify(b.paidSettlements||{}),
            new Date().toISOString()
          ).run();
          return json({ ok: true });
        }

        if (method === 'PUT' && id) {
          const b = await req.json();
          const authed = await validateToken(req, env, b.tripId);
          if (!authed) return err('Unauthorized', 401);
          await env.DB.prepare(
            `UPDATE expenses SET desc=?,amount=?,paid_by=?,date=?,note=?,category=?,
             split_between=?,photo=?,paid_settlements=? WHERE id=?`
          ).bind(
            b.desc, b.amount, b.paidBy, b.date||null, b.note||null,
            b.category||'other',
            JSON.stringify(b.splitBetween||[]),
            b.photoKey||null,
            JSON.stringify(b.paidSettlements||{}),
            id
          ).run();
          return json({ ok: true });
        }

        if (method === 'DELETE' && id) {
          // fetch tripId for auth + R2 cleanup
          const exp = await env.DB.prepare(`SELECT trip_id, photo FROM expenses WHERE id=?`).bind(id).first();
          if (!exp) return err('Not found', 404);
          const authed = await validateToken(req, env, exp.trip_id);
          if (!authed) return err('Unauthorized', 401);
          await deletePhoto(env, exp.photo);
          await env.DB.prepare(`DELETE FROM expenses WHERE id=?`).bind(id).run();
          return json({ ok: true });
        }
      }

      // ── PHOTOS ────────────────────────────────────────────
      // Upload:  POST /api/photos?tripId=xxx   body: raw binary, Content-Type: image/*
      // Serve:   GET  /api/photos/:key
      // Delete:  DELETE /api/photos/:key?tripId=xxx
      if (resource === 'photos') {

        if (method === 'POST') {
          const tripId = url.searchParams.get('tripId');
          const authed = await validateToken(req, env, tripId);
          if (!authed) return err('Unauthorized', 401);
          const ct = req.headers.get('Content-Type') || 'image/jpeg';
          const ext = ct.split('/')[1]?.split(';')[0] || 'jpg';
          const key = `photos/${tripId}/${crypto.randomUUID()}.${ext}`;
          await uploadPhoto(env, key, req.body, ct);
          return json({ key, url: `${url.origin}/api/photos/${key}` });
        }

        if (method === 'GET' && id) {
          // id here is actually the full key after /api/photos/
          const key = url.pathname.replace('/api/photos/', '');
          const obj = await env.R2.get(key);
          if (!obj) return err('Not found', 404);
          return new Response(obj.body, {
            headers: {
              'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
              'Cache-Control': 'public, max-age=31536000, immutable',
              ...CORS,
            },
          });
        }

        if (method === 'DELETE' && id) {
          const tripId = url.searchParams.get('tripId');
          const authed = await validateToken(req, env, tripId);
          if (!authed) return err('Unauthorized', 401);
          const key = url.pathname.replace('/api/photos/', '');
          await deletePhoto(env, key);
          return json({ ok: true });
        }
      }

      // ── HISTORY ───────────────────────────────────────────
      if (resource === 'history' && method === 'POST') {
        const b = await req.json();
        const authed = await validateToken(req, env, b.tripId);
        if (!authed) return err('Unauthorized', 401);
        await env.DB.prepare(
          `INSERT INTO history (id,trip_id,ts,who,action,desc,amount,changes)
           VALUES (?,?,?,?,?,?,?,?)`
        ).bind(crypto.randomUUID(), b.tripId, b.ts, b.who,
               b.action, b.desc, b.amount||null, b.changes||null).run();
        return json({ ok: true });
      }

      // ── SETTLEMENTS ───────────────────────────────────────
      if (resource === 'settlements') {
        if (method === 'POST') {
          const b = await req.json();
          const authed = await validateToken(req, env, b.tripId);
          if (!authed) return err('Unauthorized', 401);
          await env.DB.prepare(
            `INSERT OR REPLACE INTO settlements (id,trip_id,from_person,to_person,amount,ts)
             VALUES (?,?,?,?,?,?)`
          ).bind(b.id, b.tripId, b.from, b.to, b.amt, b.ts).run();
          return json({ ok: true });
        }
        if (method === 'DELETE' && id) {
          const tripId = url.searchParams.get('tripId');
          const authed = await validateToken(req, env, tripId);
          if (!authed) return err('Unauthorized', 401);
          await env.DB.prepare(`DELETE FROM settlements WHERE id=?`).bind(id).run();
          return json({ ok: true });
        }
      }

      return err('Not found', 404);

    } catch (e) {
      console.error(e);
      return err(e.message, 500);
    }
  }
};
