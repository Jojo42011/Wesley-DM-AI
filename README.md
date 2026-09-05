# Wesley DM AI — TikTok Lead Concierge

Production-grade TikTok DM automation for Wesley (realtor). Inbound TikTok DMs
arrive via **ManyChat**, the engine understands the conversation, replies in
Wesley's voice, and deterministically captures **phone numbers** — then hands
leads off to the CRM. A clean dashboard shows every metric and lead live.

```
TikTok DM → respond.io → POST /webhook/respondio → pipeline → reply
                                                      ↓          ↓
                              SQLite / CRM handoff    respond.io Developer API → TikTok
```

**respond.io is transport only.** It is the TikTok inbox and the delivery
channel. The brain (voice, intent gate, funnel, phone extraction, CRM
handoff) stays in this backend and is unchanged. Nothing is rebuilt or
retrained inside respond.io.

## Quick start

```bash
npm install
cp .env.example .env          # add ANTHROPIC_API_KEY
DEMO_MODE=1 npm run dev       # boots on :3000 with demo data (./data/wesley.db)
open http://localhost:3000    # the dashboard; /testing simulates fresh leads
npm test                      # tests, all deterministic (no network)
```

Storage is **SQLite** at `SQLITE_PATH` (default `./data/wesley.db`; on Fly a
mounted volume at `/data/wesley.db`). No external database needed. The app
runs as a single always-on machine — SQLite is single-writer, which matches
the per-conversation lock design. `STORE=memory` gives an ephemeral store for
tests and throwaway runs (refused in production).

## respond.io transport (production)

`POST /webhook/respondio` — point respond.io's **New Incoming Message**
webhook here. Optionally append `?secret=...` (or send `X-Webhook-Secret`)
and set `RESPONDIO_WEBHOOK_SECRET` to reject anything else.

What the handler does, in order:

1. **Verifies the shared secret** when one is configured.
2. **Filters to Wesley's TikTok channel** by channel id (auto-discovered at
   boot via `GET /space/channel`, or pinned with
   `RESPONDIO_TIKTOK_CHANNEL_ID`) and by channel `source`
   (`tiktok_business`). Everything else returns 200 and is ignored.
3. **Handles outbound echoes without replying.** Messages Wesley types
   himself in the respond.io inbox are *recorded* as assistant turns, which
   is how his manual opener is preserved: when the lead answers, the agent
   already has his exact words in history and continues the thread instead
   of restarting it. Echoes of our own delivered replies are detected by
   similarity and never double-recorded.
4. **Deduplicates** on the respond.io message id (`respondio:<messageId>`)
   through the existing durable idempotency table.
5. **Runs the unchanged pipeline** — intent gate, deterministic guards,
   voice generation, phone extraction, CRM handoff.
6. **Delivers the reply** with `POST /contact/id:<contactId>/message`,
   retrying 429/5xx with exponential backoff.
7. **Retry protection**: if processing throws before a reply exists, the
   idempotency claim is released so respond.io's retry is genuinely
   reprocessed rather than swallowed as a duplicate. A delivery failure
   returns 502 so respond.io retries.

Identity: the respond.io **contact id** is the stable key
(`respondio:<id>`), so a TikTok username change never splits a lead.

Verified endpoints (live, 2026-09):

```
GET  https://api.respond.io/v2/space/channel
     -> {"items":[{"id":551174,"name":"TikTok Business messaging",
                   "source":"tiktok_business"}]}
POST https://api.respond.io/v2/contact/id:<contactId>/message
     Authorization: Bearer $RESPONDIO_API_TOKEN
     {"message":{"type":"text","text":"..."},"channelId":551174}
```

## ManyChat webhook contract (legacy / simulator)

Kept so the `/testing` console can drive the pipeline without sending real
messages. Not used by production traffic.

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
- `marco_previous_outbound` is accepted as a **temporary migration alias** and
  normalized immediately; the legacy name never reaches domain logic.
- Unresolved ManyChat tokens (`{{...}}`) in **identity** fields → HTTP 400.
  Braces typed by a real person in the message body are always allowed.
- Prefer a stable subscriber ID in `user_id`; username changes are tracked as
  aliases so a rename never creates a duplicate lead.

## How a turn is processed

1. Echo events ignored; durable **idempotency** (provider message ID, or a
   bounded fallback key) — a duplicate never gets a second reply.
2. Per-conversation **lock** (FIFO in-process + pg advisory lock): rapid
   distinct messages are serialized, never dropped.
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
`GET /health`.

## Wesley's voice

`src/voice/` contains the screenshot ingestion pipeline (transcribe → attribute
→ **redact** → split → tag → **human approve**). Only approved, PII-clean
examples are ever retrieved (3–8 per turn, matched by stage/sentiment/intent).
The starter profile in `src/config/wesleyVoice.ts` is conservative — the
system has **not** learned Wesley's voice until his 50 screenshots are
ingested, approved, and evaluated against held-out conversations.

Drop approved examples at `data/voice-examples.json` (or set
`VOICE_EXAMPLES_PATH`).

## Configuration Wesley must confirm before launch

All business behavior lives in `src/config/campaigns.ts` (nothing is
hard-coded in the engine). Placeholders are marked `[WESLEY: ...]`:

- What he's offering + the exact value proposition
- Campaign objective(s) and desired conversion action (currently: phone)
- Facts the bot may state / claims it must never make
- Escalation conditions, approved fallback wording, working hours
- Consent & opt-out requirements for his jurisdiction
- The 50 screenshot conversations (with consent) + a held-out eval set

## Environment variables

See `.env.example`. Key ones: `ANTHROPIC_API_KEY`, `SQLITE_PATH`,
`ANTHROPIC_MODEL` (default `claude-haiku-4-5`), `HANDOFF_WEBHOOK_URL`,
`DEMO_MODE`, `PORT`.

## Project layout

```
src/
  app/          pipeline, guards, preflight, validator, fallbacks, locks
  domain/       types, stages, transitions
  modules/      intent gate, opener seeding, contact capture, closeout, qualification
  voice/        example store/retrieval, screenshot ingestion
  integrations/ ManyChat adapter, Anthropic client, CRM handoff
  persistence/  SQLite + in-memory stores, idempotency, handoff jobs
  api/          dashboard metrics/lead APIs
  config/       campaign policy, voice profile
public/         the Lead Desk dashboard
tests/          42 tests covering the full required scenario list
```
