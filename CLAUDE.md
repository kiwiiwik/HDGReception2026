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

## Current Status
System is live and deployed. Recent fixes:
- `known_callers.txt` path now configurable via env var for Azure persistence
- Fixed ElevenLabs sending `'None'` string for null system variables
- Removed `dynamic_variables` (was causing ElevenLabs disconnects) — use server-side lookup instead

## Known Issues
- Agent reliability has reportedly decreased — needs investigation

## Deployment
Push to `main` branch → GitHub Actions auto-deploys to Azure Web App.
