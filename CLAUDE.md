# AI Receptionist Platform

## Project Purpose
A multi-business AI phone receptionist platform. Each business gets its own AI receptionist
personality, staff directory, and ElevenLabs agent. Calls arrive via Twilio, are bridged through
an Azure Web App to ElevenLabs conversational AI, and routed to staff or messages taken.

Currently live businesses:
- **HDG** — HDG Construction, Gibbons Rail and Total Rail Solutions (receptionist: Lauren)
- **DEMO** — Demo Company (receptionist: Alex)

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
- **AI**: ElevenLabs agent (one per business) + Gemini 2.5 Flash Lite LLM
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

## API Endpoints
Business-specific (preferred — configure Twilio and ElevenLabs tools to use these):
- `POST /incoming-call/:businessId` — Twilio webhook for new calls
- `POST /transfer-call/:businessId` — Transfer to staff (ElevenLabs tool webhook)
- `POST /send-message/:businessId`  — Take a message (ElevenLabs tool webhook)
- `POST /send-text/:businessId`     — SMS to caller (ElevenLabs tool webhook)
- `POST /reload-directory/:businessId` — Hot-reload business config from disk

Shared / legacy:
- `POST /transfer`       — Twilio TwiML response for active call transfer
- `POST /call-ended`     — Twilio StatusCallback — fetches transcript, emails it
- `GET  /health`         — Shows all loaded businesses and their stats
- `POST /reload-directory` — Hot-reload all businesses

Legacy (no businessId) — defaults to `hdg` for backward compatibility:
- `POST /incoming-call`, `/transfer-call`, `/send-message`, `/send-text`, `/send-email`

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
