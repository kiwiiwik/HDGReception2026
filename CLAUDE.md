# AI Receptionist Platform

## Project Purpose
A multi-business AI phone receptionist platform. Each business gets its own AI receptionist
personality, staff directory, and ElevenLabs agent. Calls arrive via Twilio, are bridged through
an Azure Web App to ElevenLabs conversational AI, and routed to staff or messages taken.

Currently live businesses:
- **HDG** — HDG Construction, Gibbons Rail and Total Rail Solutions (receptionist: Lauren)
- **DEMO** — Demo Company (receptionist: Alex)
- **IDI** — Intelligent Document Imaging, +64 9 873 7123 (receptionist: Heather, ring-reclaim mode,
  transfers immediately to Rod's mobile without asking the caller's name)

## Architecture
```
Twilio number (per business)
  → POST /incoming-call/{businessId}   (Azure Web App)
    → wss://.../media-stream?business={businessId}  (WebSocket bridge)
      → ElevenLabs Agent (per business — own agent ID, voice, personality)
        → POST /transfer-call/{businessId}  → Twilio transfer to staff
        → POST /send-message/{businessId}   → Email to staff member
        → POST /send-text/{businessId}      → SMS to caller
```

## Key Technologies
- **Backend**: Node.js / Express (`azure-webapp/index.js`, ~500 lines)
- **Telephony**: Twilio (calls, WebSocket, mulaw audio)
- **AI**: ElevenLabs agent (one per business) + Gemini LLM (HDG: 2.5 Flash since 2026-10-24 — Flash Lite spoke a tool call aloud as code; others: 2.5 Flash Lite)
- **Hosting**: Azure Web App (`receptionisthdg.azurewebsites.net`)
- **Email**: Nodemailer + SMTP2GO (shared SMTP, per-business recipients)
- **CI/CD**: GitHub Actions → auto-deploy to Azure on push to main

## Business Directory Structure
Each business lives in `azure-webapp/businesses/{businessId}/`:

```
azure-webapp/businesses/
  hdg/
    config.json                  ← agent ID, name, phone, hours, email recipients
    callee_list.txt              ← staff directory (Name,email,phone,role)
    known_callers.txt            ← local seed (Azure persists to /home/data/hdg/)
    prompt-hours-known.md        ← business hours, caller is known
    prompt-hours-unknown.md      ← business hours, caller is unknown
    prompt-afterhours-known.md   ← after hours, caller is known
    prompt-afterhours-unknown.md ← after hours, caller is unknown
    prompt-noanswer.md           ← OPTIONAL — ring-reclaim leg only (see Transfer Modes)
  demo/
    (same structure)
```

### config.json fields
```json
{
  "id": "hdg",
  "displayName": "HDG Construction, Gibbons Rail and Total Rail Solutions",
  "receptionistName": "Lauren",
  "elevenLabsAgentId": "agent_01jysz8r0bejrvx2d9wv8gckca",
  "officePhone": "(09) 415-8327",
  "address": "Unit 4 / 485A Rosebank Road, Avondale, Auckland 1026",
  "officeHours": { "timezone": "Pacific/Auckland", "start": "08:00", "end": "17:00", "days": [1,2,3,4,5] },
  "emailRecipients": ["rod.grant@hdg.co.nz"],
  "fallbackEmail": "rod.grant@i6.co.nz"
}
```

Optional fields:
- `greeting` — custom opening line for unknown callers. Without it, a generic line is built
  from `displayName`. **The ElevenLabs dashboard "First message" box is never used** — the
  bridge always overrides it, so set the wording here.
- `greetingKnown` — opening line for recognised callers; `{firstName}` is substituted.
- `transferMode` / `ringTimeout` — see Transfer Modes below.
- `failoverNumber` — E.164 number the call is redirected to if ElevenLabs can't be reached
  (signed-URL failure or agent closes before the conversation starts). The error is written
  to the daily interaction log and an alert is emailed to `fallbackEmail` (max once per 30 min).
  Without it the caller is hung up on. Must not divert back to the Twilio number (loop).

Note the same applies to the dashboard **System prompt**: it is a fallback for when
overrides fail. Editing it has no effect on live calls — edit the `prompt-*.md` files.

## API Endpoints
Business-specific (preferred — configure Twilio and ElevenLabs tools to use these):
- `POST /incoming-call/:businessId` — Twilio webhook for new calls
- `POST /transfer-call/:businessId` — Transfer to staff (ElevenLabs tool webhook)
- `POST /send-message/:businessId`  — Take a message (ElevenLabs tool webhook)
- `POST /send-text/:businessId`     — SMS to caller (ElevenLabs tool webhook)
- `POST /reload-directory/:businessId` — Hot-reload business config from disk

Shared / legacy:
- `POST /transfer`       — Twilio TwiML response for active call transfer
  (`?mode=ring-reclaim&timeout=N&business=X&callee=Y` emits a timed `<Dial>` instead)
- `POST /dial-result/:businessId` — Twilio `<Dial action>` callback for ring-reclaim
- `POST /call-ended`     — Twilio StatusCallback — fetches transcript, emails it
- `GET  /health`         — Shows all loaded businesses and their stats
- `POST /reload-directory` — Hot-reload all businesses

Legacy (no businessId) — defaults to `hdg` for backward compatibility:
- `POST /incoming-call`, `/transfer-call`, `/send-message`, `/send-text`, `/send-email`

## Transfer Modes
Set per business via `config.json`:

- **`"transferMode"` absent (default)** — blind transfer. `/transfer` returns
  `<Dial>{number}</Dial>`; the agent leaves the call permanently. If the callee doesn't
  answer, the caller lands in the callee's own voicemail. HDG and DEMO use this.

- **`"transferMode": "ring-reclaim"`** — ring for `ringTimeout` seconds (default 25),
  then take the caller back. ROD uses this.

```
Agent calls TransferCall_X
  → /transfer-call/{id} marks pendingReclaim, redirects the live call
    → /transfer?mode=ring-reclaim  →  <Dial timeout="25" action="/dial-result/{id}">
      ├── answered → …call proceeds… → /dial-result [completed] → <Hangup/>
      │                                 + summary email + transcript
      └── no-answer / busy / failed → /dial-result
            → new <Connect><Stream> with mode=noanswer & attempted_callee
              → agent reopens on prompt-noanswer.md, takes a message,
                calls SendMessage_X, ends the call
```

Three things this mode has to get right, all handled in `index.js`:
1. **Transcript dedup** — redirecting the live call fires the WebSocket `stop` event.
   `pendingReclaim` (call_sid → timestamp) suppresses the transcript email there so the
   `transcriptSent` guard doesn't swallow the message leg, which shares the same CallSid.
2. **Two conversations, one call** — each leg opens its own ElevenLabs conversation. The
   bridge records every `conversation_id` into `activeCallStore[sid].conversationIds`, and
   `sendTranscriptEmail` fetches them by ID and stitches them into one "Part 1 / Part 2"
   email. The old "most recent conversation" lookup remains as a fallback only.
3. **No premature success email** — in ring-reclaim mode `/transfer-call` skips the call
   summary (the outcome isn't known while it's still ringing); `/dial-result` sends it.

## Purchase Orders (HDG — POC)
Staff ring Lauren and say "purchase order", "PO" or "PO number". She takes the items **one line
at a time**: each is saved with `AddLineItem` (`POST /po-line/hdg/add`, also `/change`, `/remove`)
and echoed back, so every quantity is checked as it's given. Then she asks for cost, supplier and
job, and calls `SubmitPurchaseOrder` (`POST /purchase-order/hdg`). The server holds the lines per
call (in memory, keyed by call SID). The final check is just the totals ("7 items, about $1,280 at
Bunnings, Westfield job — shall I send it?"), and only a call carrying the caller's own yes
(`Caller_Confirmation`) submits. Tools are managed by `scripts/add-po-tool-hdg.js`. All logic is in
`azure-webapp/purchase-orders.js`; config is `purchaseOrders` in `hdg/config.json`.

Why line by line: a long list spoken in one go was cut off by line noise (~40 s read-back), and
passing it as one long tool argument made Flash Lite speak the tool call aloud as code. A
single-`Description` path remains as a fallback (long ones are texted to the caller to check).

- **Requester** = caller ID matched against `callee_list.txt` phones. Not staff → refused.
- **Job** validated against `hdg/jobs.csv` by number, or by name if exactly one job matches. The
  list is appended to Lauren's prompt too. Columns come from the header row
  (`Job,Description,Supervisor,ProjectManager,Director`). Reload: `/reload-directory/hdg`.
- **Roles are per job.** Each role cell holds staff names (resolved via the staff list) or emails,
  `;` between several people (all emailed, first to decide wins). Blank → `defaultApprovers`.
- **Cascade** (`approvalLevels`): every PO needs at least the first level — no self-approval (Karl's
  call; `selfApproveUnder` would re-enable issuing on the call, but is unset). The request climbs
  Site Supervisor → Project Manager → Director, stopping at the first
  level whose `upTo` exceeds the amount ($100 / $500 / none). The next level is only emailed once
  the one below approves. Any rejection ends it. The requester is never their own approver: their
  level is skipped, and if it was the top one the next level up takes its place.
- **Approval links** — `/po/review/hdg/{REQ}?s=step&a=approver&t=HMAC`, one per approver per step
  (records who clicked; a lower level's link can't decide a higher step). GET only shows the
  request; Approve/Reject is a POST, because mail scanners (Safe Links) prefetch every link.
  Secret: `PO_LINK_SECRET` env, else auto-generated in `/home/data/hdg/po-link-secret`.
- **On approval** — sequential PO number (`GR-1001`…), SMS to requester (MessageMedia = Sinch
  Engage; Twilio can't send NZ SMS), summary email to `accountsEmail`.
- **Register** — `/home/data/hdg/po-register.json` is the source of truth (numbering is safe
  because the app is single-instance and writes are synchronous). Optional SharePoint mirror:
  `purchaseOrders.sharePoint = { site, list }` + `GRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET`;
  create the list with `scripts/create-po-sharepoint-list.js`.
- Requester also gets an outcome email (to their staff-list address, or `testRequesterEmail` —
  POC only, currently worker@totalrail.co.nz; the test aliases all land in rod.grant@hdg.co.nz).
- Tool attached to the agent with `scripts/add-po-tool-hdg.js --create` (dry run without flag).

## How Prompt Selection Works (server-side)
At call time, Node.js checks:
1. Is the current NZ time within the business's configured office hours? (incl. public holidays)
2. Is the caller's phone number in `known_callers.txt`?

Then selects one of the four prompts. The LLM never decides the mode — no "Happy Holiday"
test trigger, no mid-call mode switching.

## WebSocket Bridge — ElevenLabs Init Message
On WebSocket open, the bridge sends `conversation_initiation_client_data`:
- `conversation_config_override.agent.first_message` — personalised greeting
- `conversation_config_override.agent.prompt.prompt` — selected prompt + optional [CALLER CONTEXT] block
- `custom_llm_extra_body` — `caller_name`, `caller_id` for mid-call LLM use
- **Do NOT use `dynamic_variables`** — causes ElevenLabs disconnects

When the agent ends the conversation (`end_call`, or its 20 s silence timeout), ElevenLabs closes
its socket but Twilio's stream stays open. Until 2026-10-25 this left callers on a silent live
line. The bridge now sends Twilio a `mark`, and when it echoes back (the goodbye has played),
or after 15 s, it hangs up via the REST API (`Status=completed`). It does **not** hang up when
the disconnect is part of a transfer: `transferCall()` records the redirect in `redirectedCalls`
(60 s grace, cleared when the call's next stream starts), and ring-reclaim uses `pendingReclaim`.

## Known Callers — Per Business
- On Azure: `/home/data/{businessId}/known_callers.txt` (persists across deploys)
- Locally: falls back to `azure-webapp/businesses/{businessId}/known_callers.txt`
- `KNOWN_CALLERS_DIR` env var overrides the base directory (set to `/home/data` on Azure)
- Format: `+64xxxxxxxxx,Full Name` one per line; first entry per number wins
- Auto-appended when a new caller gives their name during a call

## Adding a New Business
1. Create `azure-webapp/businesses/{id}/` with all required files (use `demo/` as template)
2. Set `elevenLabsAgentId` in `config.json` to the new ElevenLabs agent ID
3. Configure the ElevenLabs agent's tool URLs to `/transfer-call/{id}`, `/send-message/{id}`, `/send-text/{id}`
4. Configure the Twilio phone number webhook to `POST /incoming-call/{id}`
5. Enable **Security → Overrides → First message, System prompt, LLM** in the ElevenLabs dashboard
6. Push to `main` — the app auto-loads all business directories on startup

## ElevenLabs Agent Requirements (per business)
- Security → Overrides: **First message, System prompt, LLM** must all be enabled
- Tool URLs must point to the business-specific endpoints above
- The dashboard system prompt is a fallback only — code always sends prompt from file

## NZ Public Holidays
Hardcoded in `index.js` (`NZ_PUBLIC_HOLIDAYS` set). Update annually for 2027+.
Current list covers 2025 and 2026.

## Deployment
Push to `main` branch → GitHub Actions auto-deploys to Azure Web App.
