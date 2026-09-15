# Wesley DM AI — TikTok Lead Concierge

Production-grade TikTok DM automation for Wesley (realtor). Inbound TikTok DMs
arrive through the **Zernio** inbox; the engine understands the conversation,
replies in Wesley's learned voice, and deterministically captures **phone
numbers** — then hands leads off to the CRM. A clean dashboard shows every
metric and lead live.

```
TikTok DM → Zernio → POST /api/zernio/webhook → 200 (fast) → pipeline
                                                                ↓
                                        Zernio send API → the lead's DM
                                                                ↓
                                     SQLite / CRM handoff / dashboard
```

**Zernio is the TikTok transport.** It is live and wired: it receives the DM,
this server generates the reply, and this server calls Zernio back to deliver
it. The brain (voice, intent gate, funnel, phone extraction, CRM handoff) is
transport agnostic and was not changed to accommodate it.

`POST /webhook/tiktok` still exists as the ManyChat-shaped **testing
simulator** behind the `/testing` console. It is no longer a public endpoint;
see [Access control](#access-control).

## Quick start

```bash
npm install
cp .env.example .env          # add ANTHROPIC_API_KEY
DEMO_MODE=1 npm run dev       # boots on :3000 with demo data (./data/wesley.db)
open http://localhost:3000    # the dashboard; /testing simulates fresh leads
npm test                      # 162 tests, all deterministic (no network)
npm run verify:zernio         # live route checks against a throwaway server
```

Storage is **SQLite** at `SQLITE_PATH` (default `./data/wesley.db`; on Fly a
mounted volume at `/data/wesley.db`). No external database needed. The app
runs as a single always-on machine — SQLite is single-writer, which matches
the per-conversation lock design. `STORE=memory` gives an ephemeral store for
tests and throwaway runs (refused in production).

## Transport: the Zernio TikTok inbox

Zernio is the only route available that can both receive a TikTok DM and reply
to one, so it is the live transport. The whole integration is one module
(`src/integrations/zernio/dm.ts`), one route handler
(`src/app/zernioWebhook.ts`) and the batching window
(`src/app/messageDebounce.ts`). Nothing in the pipeline changed.

### The one architectural fact that shapes it

ManyChat called this server and sent whatever came back in the response body.
Zernio inverts that:

```
ManyChat:  POST /webhook/tiktok      -> { reply }   -> ManyChat sends it
Zernio:    POST /api/zernio/webhook  -> 200 (fast)  -> WE call Zernio to send
```

Zernio needs a 2xx **within five seconds** or it retries, and a retried inbound
is a duplicate DM. A turn here holds a four second batching window and then
makes two Anthropic calls, so the route acks first and runs everything else off
the response. Measured ack: single digit milliseconds.

### `POST /api/zernio/webhook`

Checks, in order, all before the ack:

| # | Check | Failure |
|---|-------|---------|
| 1 | `ZERNIO_WEBHOOK_SECRET` is set | **503** — fails closed, never open |
| 2 | `X-Zernio-Signature` verifies against the **raw** body | 401 |
| 3 | Body parses as JSON | 400 |
| 4 | `message.received`, TikTok, incoming, has a sender | 200 `ignored` |
| 5 | `account.accountId` equals `ZERNIO_TIKTOK_ACCOUNT_ID` | 200 `ignored` |
| 6 | Zernio event id not already seen | 200 `duplicate` |
| 7 | **Ack 200.** Opener recovery, batching, pipeline and send run after. | |

The signature is a lowercase hex HMAC-SHA256 over the exact request bytes,
compared in constant time. The body is read as a `Buffer` and parsed only after
the signature clears, because re-serializing a parsed body is not byte
identical to what was signed.

### Account isolation

Every inbound event is checked against `ZERNIO_TIKTOK_ACCOUNT_ID` before any
work happens. Anything else gets 200 `ignored` with no lead, no pipeline run and
no send. An **unset** account id matches nothing at all, so a misconfigured
server ignores traffic rather than answering someone else's leads.

### How the funnel starts (same as Marco)

TikTok does not let a business **start** a DM. The lead must message first —
that is the primary path, and it is how Marco's TikTok funnel runs too:

1. Someone DMs `@dulinrealestate` (keyword from a video, "hey", etc.)
2. Zernio fires `message.received` → this server acks, runs the pipeline, sends
3. No VA opener is required. `fetchManualOpener()` returns null; the turn still
   continues. New cold leads pass the intent gate (bare keywords like `SUNSET`
   are always accepted).

The **optional** VA path is only for when a human already opened the thread in
the TikTok app. ManyChat used to pass that opener as a webhook field; Zernio
has none, so it is read back off the conversation (latest outgoing text before
the inbound). `seedManualOpener()` seeds it once for context. A missing opener
never blocks the reply — same rule as Marco's `fetchVaOpener`.

### Rapid messages

People send "hey", then "saw your video", then "im in round rock" over four
seconds. `InboundBatcher` folds a burst into one turn and one reply; only the
last delivery in a batch sends. A message that arrives **while a turn is
running** is queued as the next turn, never dropped, and every provider message
id in a batch is recorded so none can be replayed.

### Duplicates

Three independent layers, keyed differently so none can cancel another:

1. the route claims Zernio's **event id** before any work
2. the pipeline claims the **provider message id**, as it always has
3. the send carries `Idempotency-Key: zernio:{event id}`

### Delivery

`POST /v1/inbox/conversations/{conversationId}/messages` with
`{"accountId": "...", "message": "..."}`. A `reply: null` sends nothing at all.
A TikTok **messaging window** rejection (the 48 hour / 10 message rule) is
reported as `windowClosed` and logged as TikTok refusing, distinctly from an AI
failure, because nothing is broken: the lead went quiet too long and a human has
to reopen the thread.

Credentials never leave the transport module. Error strings are bounded and
scrubbed of bearer tokens and key-shaped values before they reach a log.

### `GET /api/zernio/status`

Dashboard-authenticated. Reports whether the API key and webhook secret are
configured, the configured account id, whether Zernio auth succeeds, the
connected TikTok accounts, and whether Wesley's account is present and active.
It never returns the key or the secret.

## Access control

| Route | Gate |
|-------|------|
| `POST /api/zernio/webhook` | HMAC signature only — **never** the dashboard token |
| `GET /health` | open, for Fly's checker |
| `/`, `/testing`, `/api/metrics`, `/api/leads`, `/api/leads/:id/conversation`, `/api/testing/state`, `/api/zernio/status` | `DASHBOARD_TOKEN` |
| `POST /webhook/tiktok` (simulator) | `TESTING_WEBHOOK_SECRET`, a dashboard session, or `DEMO_MODE=1` |

The dashboard token is accepted as `?token=`, `Authorization: Bearer`, or the
`wesley_dash` cookie. Visiting `/?token=...` once sets that cookie (HttpOnly,
SameSite=Strict, Secure) so the page's own API calls authenticate without the
token in every URL.

With `DASHBOARD_TOKEN` unset the dashboard returns **503**, not an open page.
`DEMO_MODE=1` is the only exception, and it means the instance holds seeded
data.

## Testing simulator contract

`POST /webhook/tiktok` — the ManyChat-shaped testing simulator. It drives the
`/testing` console. It is authenticated (see [Access control](#access-control))
and is not the production transport; Zernio is.

`POST /webhook/tiktok`

```json
{
  "platform": "tiktok",
  "user_id": "{{TikTok Username or stable subscriber ID}}",
  "username": "{{TikTok Username}}",
  "display_name": "{{Full Name}}",
  "message": "{{Last Text Input}}",
  "message_id": "{{Message ID if available}}",
  "wesley_previous_outbound": "Exact manual message Wesley sent before the reply",
  "conversation_goal": "{{optional campaign key}}",
  "source_campaign": "{{optional campaign identifier}}"
}
```

Response: `{ "reply": "single message to send" }` or `{ "reply": null }` for
intentional silence (HTTP 200 either way).

Notes:
- Prefer a stable id in `user_id`; username changes are tracked as aliases so
  a rename never creates a duplicate lead.
- Unresolved `{{...}}` template tokens in **identity** fields are rejected
  with HTTP 400. Braces typed by a real person in the message body are always
  allowed.
- `wesley_previous_outbound` seeds a manual opener exactly once, so the agent
  continues Wesley's thread instead of reintroducing itself.

## How a turn is processed

1. Echo events ignored; durable **idempotency** (provider message ID, or a
   bounded fallback key) — a duplicate never gets a second reply.
2. Per-conversation **lock** (in-process FIFO queue): rapid distinct messages
   are serialized, never dropped.
3. Lead loaded/created. New cold leads pass an **intent gate** (deterministic
   spam/denial/safety exclusions first, low-cost classifier for ambiguity —
   low confidence never discards a real person).
4. Manual Wesley opener seeded **exactly once** as `manual_seed`.
5. Deterministic guards, in priority order: safety escalation → opt-out →
   contact captured → ack-after-commitment silence → "already sent it" →
   pinned answers → CTA refusal (lower pressure) → agreement (next CTA) →
   closeout → model reply.
6. Model pathway: turn **preflight** (dedupe math is code-authoritative;
   model adds sentiment/coaching) → prompt built from CAMPAIGN_POLICY +
   WESLEY_VOICE_PROFILE + MATCHED_VOICE_EXAMPLES + TURN_RULES → reply
   validated (length, similarity vs recent outbound, prohibited claims,
   captured-field re-asks, assistant phrases, sentiment fit) → one
   RETROACTIVE_FIX retry → deterministic fallback. Provider failure never
   crashes a turn.
7. Contact extraction is **code, not model prose**: libphonenumber E.164
   normalization, junk/context rejection (prices, years, sqft are not
   phones), captured once, confirmed once, CRM handoff triggered
   idempotently. CRM downtime queues a retry without losing the DM reply.

## Dashboard

`GET /` serves the Lead Desk — numbers captured (+rate), total leads, active
conversations, needs-attention, a 14-day lead-flow chart, pipeline funnel,
and a live leads table with click-through conversation view. Contact values
are masked (last 4 digits) — it is a monitoring surface, not an export tool.

APIs: `GET /api/metrics`, `GET /api/leads`, `GET /api/leads/:id/conversation`,
`GET /api/zernio/status`, `GET /health`. All but `/health` require
`DASHBOARD_TOKEN`.

## Wesley's voice

`src/voice/` contains the screenshot ingestion pipeline (transcribe → attribute
→ **redact** → split → tag → **human approve**). Only approved, PII-clean
examples are ever retrieved (3–8 per turn, matched by stage/sentiment/intent).

**Wesley's voice is trained.** 55 real TikTok conversations were transcribed,
redacted and tagged into the 76 examples shipped at
`data/voice-examples.json` (override with `VOICE_EXAMPLES_PATH`), and
`src/config/wesleyVoice.ts` is derived from them: his scripted openers, the
number ask framed as delivery logistics, exclamation-first greetings, dropped
closing punctuation, near-zero emoji, and one graceful alternative before
accepting a no. **He never uses hyphens or em dashes**, which the reply
sanitizer enforces on every generated message.

## Configuration Wesley must confirm before launch

All business behavior lives in `src/config/campaigns.ts` (nothing is
hard-coded in the engine). Placeholders are marked `[WESLEY: ...]`:

- What he's offering + the exact value proposition
- Campaign objective(s) and desired conversion action (currently: phone)
- Facts the bot may state / claims it must never make
- Escalation conditions, approved fallback wording, working hours
- Consent & opt-out requirements for his jurisdiction
- A held-out set of real conversations for evaluation

## Environment variables

See `.env.example`. Required in production: `ANTHROPIC_API_KEY`,
`ZERNIO_DM_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `ZERNIO_TIKTOK_ACCOUNT_ID`,
`DASHBOARD_TOKEN`. Also `SQLITE_PATH`, `ANTHROPIC_MODEL` (default
`claude-haiku-4-5`), `HANDOFF_WEBHOOK_URL`, `TESTING_WEBHOOK_SECRET`,
`DEMO_MODE`, `PORT`. No real credential is ever committed.

## Project layout

```
src/
  app/          pipeline, guards, preflight, validator, fallbacks, locks,
                Zernio webhook route, rapid-message batching
  domain/       types, stages, transitions
  modules/      intent gate, opener seeding, contact capture, closeout, qualification
  voice/        example store/retrieval, screenshot ingestion
  integrations/ Zernio DM transport, ManyChat adapter, Anthropic client, CRM handoff
  http/         dashboard and simulator access control
  persistence/  SQLite + in-memory stores, idempotency, handoff jobs
  api/          dashboard metrics/lead APIs
  config/       campaign policy, voice profile
public/         the Lead Desk dashboard
scripts/        verify-zernio-webhook.mjs (live route checks over real HTTP)
tests/          162 tests covering the full required scenario list
```
