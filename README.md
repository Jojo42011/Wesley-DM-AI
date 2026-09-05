# Wesley DM AI — TikTok Lead Concierge

Production-grade TikTok DM automation for Wesley (realtor). Inbound TikTok DMs
reach the engine over a pluggable transport; it understands the conversation,
replies in Wesley's learned voice, and deterministically captures **phone
numbers** — then hands leads off to the CRM. A clean dashboard shows every
metric and lead live.

```
TikTok DM → [transport] → POST /webhook/tiktok → pipeline → { "reply": "..." }
                                                    ↓
                                     SQLite / CRM handoff / dashboard
```

**The transport is pluggable and currently unwired.** The brain (voice,
intent gate, funnel, phone extraction, CRM handoff) is transport agnostic
and complete. The plan is to connect **TikTok's Business Messaging API
directly** once access is approved; until then `POST /webhook/tiktok`
accepts the simple JSON contract below, which is what the `/testing`
console uses.

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

## Transport: direct TikTok Business Messaging (planned)

The integration target is TikTok's Business Messaging API, applied for
directly rather than through a third party inbox. When access is granted,
the work is confined to one adapter plus one route:

1. Verify TikTok's webhook signature and answer the callback fast.
2. Map TikTok's payload to `InboundEvent` (stable user id, text, provider
   message id) — the same shape the pipeline already consumes.
3. Drop echoes of the business account's own messages.
4. Call `processInboundEvent` unchanged.
5. Deliver `outcome.reply` through TikTok's send endpoint.

Everything else — dedupe, per-conversation locking, guards, voice,
extraction, handoff, dashboard — already exists and does not change.

Two constraints to design around, from TikTok's own rules: business
initiated conversations are not permitted (every turn must answer an
inbound DM, which is exactly how this pipeline behaves), and DM API access
is unavailable to EEA, Switzerland and UK accounts.

## Current webhook contract

`POST /webhook/tiktok` — the generic transport entry point. It drives the
`/testing` console today and is what a transport adapter will call.

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
`GET /health`.

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
  integrations/ webhook adapter, Anthropic client, CRM handoff
  persistence/  SQLite + in-memory stores, idempotency, handoff jobs
  api/          dashboard metrics/lead APIs
  config/       campaign policy, voice profile
public/         the Lead Desk dashboard
tests/          42 tests covering the full required scenario list
```
