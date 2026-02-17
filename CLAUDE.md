# HDG Reception 2026

## Project Purpose
AI-powered phone receptionist for HDG Construction, Gibbons Rail, and Total Rail Solutions (NZ).
Answers incoming calls via Twilio, uses ElevenLabs conversational AI ("Lauren") to route calls
to staff during business hours (8am–5pm Mon–Fri NZ time), or takes messages after hours.

## Architecture
```
Twilio (incoming call)
  → Azure Web App (index.js WebSocket bridge)
    → ElevenLabs AI Agent ("Lauren")
      → TransferCall webhook  → Twilio transfer to staff
      → SendMessage webhook   → Email/SMS to staff
```

## Key Technologies
- **Backend**: Node.js / Express (`azure-webapp/index.js`, ~1050 lines)
- **Telephony**: Twilio (calls, WebSocket, mulaw audio)
- **AI**: ElevenLabs agent + Gemini 2.5 Flash Lite LLM
- **Hosting**: Azure Web App (`receptionisthdg.azurewebsites.net`)
- **Email**: Nodemailer + SMTP2GO
- **CI/CD**: GitHub Actions → auto-deploy to Azure on push to main

## Important Files
| File | Purpose |
|------|---------|
| `azure-webapp/index.js` | Main app — all endpoints and WebSocket bridge |
| `azure-webapp/callee_list.txt` | Staff directory (name, email, phone, role) |
| `azure-webapp/known_callers.txt` | Returning caller history (path configurable via KNOWN_CALLERS_DIR env var, persisted to /home/data on Azure) |
| `azure-webapp/transcript_recipients.txt` | Email addresses for call transcripts |
| `elevenlabs/agent-config.json` | Full ElevenLabs agent config |
| `elevenlabs/updated-prompt.md` | Lauren's system prompt |

## API Endpoints
- `POST /incoming-call` — Twilio webhook for new calls
- `POST /transfer-call` — Transfer to staff (ElevenLabs webhook)
- `POST /send-message` — After-hours message (ElevenLabs webhook)
- `POST /send-email` — Email notifications/transcripts
- `POST /send-text` — SMS to callers
- `GET /health` — Health check
- `POST /reload-directory` — Reload staff list from file

## ElevenLabs Agent
- Agent ID: `agent_01jysz8r0bejrvx2d9wv8gckca`
- Voice: Lauren (`w9rPM8AIZle60Nbpw7nl`)
- Audio: mulaw ↔ PCM conversion at 8000Hz/16000Hz in WebSocket bridge

## WebSocket Bridge — ElevenLabs Init Message
On WebSocket open, the bridge sends `conversation_initiation_client_data` to ElevenLabs:
```js
{
  type: 'conversation_initiation_client_data',
  custom_llm_extra_body: {
    caller_name: '<name from known_callers.txt or empty>',
    caller_id: '<E.164 phone number>'
  }
}
```
- `custom_llm_extra_body` works and is available to the LLM as context
- `conversation_config_override` works once **Security → Overrides → First message** is enabled in the ElevenLabs agent dashboard
- `dynamic_variables` causes disconnects — do NOT use

## Current Status
System is live and deployed. Recent fixes:
- Synced all three code locations (local, GitHub, Azure) — were all out of sync
- `known_callers.txt` first-entry-wins: multiple entries for same number now correctly returns the first match, not the last
- `saveKnownCaller` skips write if number already known — preserves original name
- Lauren's transfer phrase updated in prompt: "Thanks [caller's name], please stay on the line while I connect you to [callee's name]"
- `known_callers.txt` path configurable via `KNOWN_CALLERS_DIR` env var for Azure persistence
- Fixed ElevenLabs sending `'None'` string for null system variables
- Removed `dynamic_variables` (was causing ElevenLabs disconnects)

## Known Issues
- None currently known.

## Deployment
Push to `main` branch → GitHub Actions auto-deploys to Azure Web App.
