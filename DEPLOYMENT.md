# AdPlus / AdLaunch — Deployment & Operations Guide

Two services + two managed datastores:

| Piece | Where | Repo |
|---|---|---|
| **Backend** (Express ad-engine + fraud + workers) | onrender | `adplus-backend` |
| **Frontend** (Next.js dashboards + Better Auth + `/watch`) | Vercel | `adlaunch-next` |
| **MongoDB** (operational + identity) | Atlas | — |
| **Redis** (budget/pacing/frequency/fraud/queue) | Upstash | — |

> **Secrets never live in this repo.** The tables below give each variable's
> **format and purpose** — set the real values only in onrender / Vercel dashboards
> (or your secret manager). The committed `.env` still contains real secrets from an
> earlier state and must be rotated + untracked (see §5).

---

## 1. Backend env vars (onrender → `adplus-backend`)

| Variable | Required | Format / value | Notes |
|---|:--:|---|---|
| `NODE_ENV` | ✅ | `production` | enables the security guards |
| `MONGO_URI` | ✅ | `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/?appName=adlaunch` | Atlas |
| `JWT_SECRET` | ✅ **(or the app refuses to boot)** | 32+ random chars → `openssl rand -base64 32` | **must be byte-identical to the frontend `JWT_SECRET`** (the bridge signs ad-engine tokens with it) |
| `REDIS_URL` | ✅ (full engine) | `rediss://default:<password>@big-muskox-78384.upstash.io:6379` | **`rediss://` (TLS)**, not `redis://`. TLS auto-enabled for `rediss://` / `*.upstash.io`. Without Redis the engine runs degraded in-memory (per-process). |
| `OCS_TRIGGER_KEY` | ✅ (or triggers 401) | shared secret with ETC's OCS | sent by OCS as header `x-ocs-key`; **fails closed in prod if unset** |
| `WATCH_BASE_URL` | ✅ | `https://adlaunch-next.vercel.app` | used to build the SMS watch link |
| `CORS_ORIGINS` | ✅ | `https://adlaunch-next.vercel.app` | comma-separated browser allowlist |
| `WORKERS_ENABLED` | ✅ | `true` | run decision/sweeper/fraud workers in this process |
| `TOKEN_SECRET` | ✅ | random | watch-token secret |
| `API_DOMAIN` | rec | `https://adplus-backend.onrender.com` | |
| `REDIS_PREFIX` | opt | `adplus:` | Redis key namespace |
| `SUPABASE_URL` / `SUPABASE_KEY` | ✅ (uploads) | Supabase project URL + key | video/banner/KYC storage — **rotate the leaked service-role key** |
| `SMS_DRIVER` / `SMS_HTTP_URL` / `SMS_API_KEY` / `SMS_SENDER_ID` | when live | HTTP gateway | defaults to `mock` (log-only) if unset |
| `REWARD_DRIVER` / `REWARD_HTTP_URL` / `REWARD_API_KEY` | when live | sync HTTP | defaults to `mock` if unset |
| `LOG_LEVEL` | opt | `info` | |
| `FR_*`, `FREQ_*`, `SPEND_WINDOW_HOURS`, `SMS_GATEWAY_MAX_PER_SEC`, `PACING_ENABLED` | opt | see `.env.example` | fraud/pacing/frequency tuning — safe defaults |

## 2. Frontend env vars (Vercel → `adlaunch-next`)

| Variable | Required | Format / value | Notes |
|---|:--:|---|---|
| `BACKEND_URL` | ✅ | `https://adplus-backend.onrender.com/api/v1` | proxy target |
| `BETTER_AUTH_SECRET` | ✅ | `openssl rand -base64 32` | Better Auth session signing |
| `BETTER_AUTH_URL` | ✅ | `https://adlaunch-next.vercel.app` | |
| `MONGODB_URI` | ✅ | **the same Atlas URI + same database as the backend's `MONGO_URI`** | identity is co-located; the bridge/hook query that shared DB. If the backend URI has no db-name it resolves to `test` on both — keep them identical. |
| `JWT_SECRET` | ✅ | **identical to the backend `JWT_SECRET`** | the bridge (`/api/bridge-token`) signs the ad-engine JWT with this |
| `MIGRATE_KEY` | one-time | random secret | authorizes the account-migration route (§4) |

---

## 3. Critical notes

- **`JWT_SECRET` must match on both sides.** Frontend mints the ad-engine token; backend verifies it. A mismatch = every ad-engine call 401s.
- **`MONGODB_URI` (frontend) must point at the same database as `MONGO_URI` (backend).** Better Auth's `user`/`session` collections live alongside the ad-engine's `marketers`/`ads`/`watchlinks` in one DB; the bridge links them by email.
- **Upstash needs `rediss://`** (TLS). Verified working: atomic budget reserve, pacing token-buckets, and Redis Streams all run over TLS.
- **Production boot guard:** the backend exits if `JWT_SECRET` is missing/weak/placeholder — set it before onrender redeploys.
- **OCS trigger fails closed** in production without `OCS_TRIGGER_KEY`.

---

## 4. Operational commands

**Health / engine status** (redis, queue depth, worker tallies):
```bash
curl https://adplus-backend.onrender.com/api/v1/health
```

**OCS trigger — single** (OCS sends this on morning data-depreciation):
```bash
curl -XPOST https://adplus-backend.onrender.com/api/v1/trigger \
  -H 'content-type: application/json' -H 'x-ocs-key: <OCS_TRIGGER_KEY>' \
  -d '{"msisdn":"251911223344"}'
```
**OCS trigger — batch** (preferred for the morning run):
```bash
curl -XPOST https://adplus-backend.onrender.com/api/v1/trigger \
  -H 'content-type: application/json' -H 'x-ocs-key: <OCS_TRIGGER_KEY>' \
  -d '{"msisdns":["251911223344","251922334455"]}'
# -> 202 {"accepted":N,"rejected":M}   (invalid MSISDNs are rejected)
```

**Build DB indexes off-peak** (production boots with `autoIndex:false`, so run this
after any index change — it de-dupes reward tokens first, then syncs all indexes):
```bash
NODE_ENV=production node scripts/ensure-indexes.js
```

**Seed the first admin** (creates `admin@example.com` / `TempPass123`):
```bash
node createAdmin.js
```

**Migrate existing accounts into Better Auth** (one-time, from the frontend host;
imports every marketer + admin, linked by email, returns temp passwords to
distribute — users then reset via `/account/security`):
```bash
curl -XPOST https://adlaunch-next.vercel.app/api/auth-migrate \
  -H 'x-migrate-key: <MIGRATE_KEY>'
# -> { migrated: N, results: [ { email, role, tempPassword }, ... ] }
```

---

## 5. First-deploy / go-live order

1. Provision Atlas + Upstash; note the URIs.
2. Set **all** backend env vars in onrender (§1) — **especially `JWT_SECRET`** (or boot fails).
3. Set **all** frontend env vars in Vercel (§2) — `JWT_SECRET` identical, `MONGODB_URI` same DB.
4. Deploy both (push to `main` auto-deploys).
5. `node scripts/ensure-indexes.js` (off-peak) to build indexes on Atlas.
6. `node createAdmin.js` (or migrate) so an admin exists.
7. Run the Better Auth migration (§4) if importing existing accounts.
8. Point ETC's OCS at `/api/v1/trigger` with the shared `x-ocs-key`.
9. Wire the real SMS + reward payloads (`src/integrations/sms/httpSms.js`,
   `src/integrations/reward/httpReward.js`) and flip `SMS_DRIVER`/`REWARD_DRIVER` to `http`.

## 6. Security follow-ups
- **Rotate** the previously-committed **Atlas password** and **Supabase service-role key**, then `git rm --cached .env` and commit (keep the local file).
- Keep a **private** secret sheet (not in git) for the actual values.
- Consider an Upstash-backed distributed rate limiter later (current limiter is per-process).
