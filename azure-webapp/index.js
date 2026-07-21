// index.js — multi-business AI receptionist bridge
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 8080;

// ── Global credentials (shared across all businesses) ─────────────────────────
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const MESSAGEMEDIA_API_KEY = process.env.MESSAGEMEDIA_API_KEY;
const MESSAGEMEDIA_API_SECRET = process.env.MESSAGEMEDIA_API_SECRET;
const EMAIL_FROM = process.env.EMAIL_FROM || '"AI Receptionist" <ai@receptionisthdg.azurewebsites.net>';
const globalFallbackEmail = process.env.FALLBACK_EMAIL || 'rod.grant@i6.co.nz';

// Base directory for persistent known_callers data on Azure (/home persists across deploys).
// Each business gets its own sub-directory: {persistentDataBase}/{businessId}/known_callers.txt
const persistentDataBase = process.env.KNOWN_CALLERS_DIR || '/home/data';

// ── Logging ───────────────────────────────────────────────────────────────────
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

function logInteraction(entry) {
  const timestamp = new Date().toISOString();
  const date = timestamp.split('T')[0];
  const logFilePath = path.join(logDir, `agent-${date}.log`);
  fs.appendFile(logFilePath, `[${timestamp}] ${entry}\n`, err => {
    if (err) console.error('[Logger] Failed to write log:', err.message);
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatTime(secs) {
  const mins = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${mins}:${s.toString().padStart(2, '0')}`;
}

// "Unknown caller" is a display placeholder used in emails when a caller transfers
// without giving a name. It must never be treated as an actual name: stored as
// caller_name it gets read back by the ring-reclaim leg, split on the space, and
// spoken at the caller as "Sorry Unknown, I couldn't get hold of…".
function isPlaceholderName(name) {
  return /^\s*unknown(\s+caller)?\s*$/i.test(String(name || ''));
}

// XML-escape a value for safe interpolation into TwiML
function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── NZ Public Holidays ────────────────────────────────────────────────────────
// Update annually. Includes Mondayised dates where applicable.
const NZ_PUBLIC_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-02',  // New Year's Day & day after
  '2025-02-06',                 // Waitangi Day
  '2025-04-18', '2025-04-21',  // Good Friday, Easter Monday
  '2025-04-25',                 // Anzac Day
  '2025-06-02',                 // King's Birthday (first Monday in June)
  '2025-06-20',                 // Matariki
  '2025-10-27',                 // Labour Day (fourth Monday in October)
  '2025-12-25', '2025-12-26',  // Christmas & Boxing Day
  // 2026
  '2026-01-01', '2026-01-02',  // New Year's Day & day after
  '2026-02-06',                 // Waitangi Day
  '2026-04-03', '2026-04-06',  // Good Friday, Easter Monday
  '2026-04-27',                 // Anzac Day (Mondayised — 25th falls on Saturday)
  '2026-06-01',                 // King's Birthday
  '2026-07-10',                 // Matariki
  '2026-10-26',                 // Labour Day
  '2026-12-25', '2026-12-28',  // Christmas & Boxing Day (Mondayised — 26th falls on Saturday)
]);

// Returns true if the current time falls within the business's configured office hours.
// Business hours check happens server-side — the LLM does not decide.
function isBusinessHours(config) {
  const tz = config.officeHours?.timezone || 'Pacific/Auckland';
  const workDays = config.officeHours?.days || [1, 2, 3, 4, 5]; // JS: 0=Sun, 1=Mon…6=Sat

  const [startH, startM] = (config.officeHours?.start || '08:00').split(':').map(Number);
  const [endH, endM] = (config.officeHours?.end || '17:00').split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  // Use Intl to get current date/time components in the target timezone (no external deps)
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date()).map(p => [p.type, p.value]));

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = weekdayMap[parts.weekday];
  const hour = parseInt(parts.hour) % 24; // guard against '24' at midnight
  const minute = parseInt(parts.minute);
  const currentMinutes = hour * 60 + minute;
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;

  if (!workDays.includes(day)) return false;
  if (currentMinutes < startMinutes || currentMinutes >= endMinutes) return false;
  if (NZ_PUBLIC_HOLIDAYS.has(dateStr)) return false;

  return true;
}

// ── Business registry ─────────────────────────────────────────────────────────
const businessesDir = path.join(__dirname, 'businesses');
const businesses = new Map(); // businessId -> business object

function parseCalleeList(data) {
  const directory = {};
  data.split('\n').filter(l => l.trim()).forEach(line => {
    const [name, email, phone, role] = line.split(',').map(x => x.trim());
    if (name && name.toLowerCase() !== 'name') {
      directory[name.toLowerCase()] = { name, email, phone, role };
    }
  });
  return directory;
}

function loadKnownCallers(knownCallersPath) {
  if (!fs.existsSync(knownCallersPath)) return {};
  const callers = {};
  fs.readFileSync(knownCallersPath, 'utf-8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const commaIndex = trimmed.indexOf(',');
    if (commaIndex === -1) return;
    const phone = trimmed.substring(0, commaIndex).trim();
    const name = trimmed.substring(commaIndex + 1).trim();
    if (phone && name && !callers[phone]) callers[phone] = name; // first entry wins
  });
  return callers;
}

function loadBusiness(businessId) {
  const dir = path.join(businessesDir, businessId);
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));

  const calleeDirectory = parseCalleeList(
    fs.readFileSync(path.join(dir, 'callee_list.txt'), 'utf-8')
  );

  // On Azure, persist known_callers under /home/data/{businessId}/ (survives redeploys).
  // Locally (dev), fall back to the business directory itself.
  let knownCallersPath;
  const azurePersistDir = path.join(persistentDataBase, businessId);
  try {
    fs.mkdirSync(azurePersistDir, { recursive: true });
    knownCallersPath = path.join(azurePersistDir, 'known_callers.txt');
    // If the persistent file doesn't exist yet, seed it from the repo copy
    if (!fs.existsSync(knownCallersPath)) {
      const repoKCPath = path.join(dir, 'known_callers.txt');
      if (fs.existsSync(repoKCPath)) fs.copyFileSync(repoKCPath, knownCallersPath);
    }
  } catch (e) {
    // Can't write to /home/data (local dev) — use business directory
    knownCallersPath = path.join(dir, 'known_callers.txt');
  }
  const knownCallers = loadKnownCallers(knownCallersPath);

  // Load the four focused prompts
  const prompts = {};
  for (const key of ['prompt-hours-known', 'prompt-hours-unknown', 'prompt-afterhours-known', 'prompt-afterhours-unknown']) {
    try {
      prompts[key] = fs.readFileSync(path.join(dir, `${key}.md`), 'utf-8');
    } catch (e) {
      console.warn(`[Startup] Missing ${key}.md for business "${businessId}"`);
      prompts[key] = '';
    }
  }

  // Optional fifth prompt — used only on the ring-reclaim leg, when a
  // transfer rang out and the caller has been handed back to the agent.
  // Businesses using "transferMode": "blind" never load this path.
  try {
    prompts['prompt-noanswer'] = fs.readFileSync(path.join(dir, 'prompt-noanswer.md'), 'utf-8');
  } catch (e) {
    prompts['prompt-noanswer'] = ''; // falls back to the afterhours prompt at call time
  }

  // Load optional knowledge base — appended to the system prompt at call time
  let knowledge = '';
  try {
    knowledge = fs.readFileSync(path.join(dir, 'knowledge.md'), 'utf-8');
  } catch (e) {
    // knowledge.md is optional — no warning needed
  }

  const validPhoneNumbers = new Set(
    Object.values(calleeDirectory).map(e => e.phone).filter(Boolean)
  );

  return { config, calleeDirectory, knownCallers, knownCallersPath, prompts, knowledge, validPhoneNumbers };
}

function loadAllBusinesses() {
  if (!fs.existsSync(businessesDir)) {
    console.error('[Startup] businesses/ directory not found — no businesses loaded');
    return;
  }
  const dirs = fs.readdirSync(businessesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const id of dirs) {
    try {
      businesses.set(id, loadBusiness(id));
      const b = businesses.get(id);
      console.log(`[Startup] Loaded business "${id}" (${b.config.displayName}): ${Object.keys(b.calleeDirectory).length} callees, ${Object.keys(b.knownCallers).length} known callers`);
    } catch (e) {
      console.error(`[Startup] Failed to load business "${id}":`, e.message);
    }
  }
}

loadAllBusinesses();

// ── Business helpers ──────────────────────────────────────────────────────────
function getBusiness(businessId) {
  const b = businesses.get(businessId);
  if (!b) throw new Error(`Unknown business: "${businessId}"`);
  return b;
}

// Select the appropriate prompt based on time of day and whether the caller is known.
// This replaces the LLM-side hours/mode detection from the old single-prompt approach.
function selectPrompt(business, isKnownCaller, isReclaimLeg) {
  const inHours = isBusinessHours(business.config);
  // Reclaim leg: the transfer rang out and the caller is back with the agent.
  // Fall back to the afterhours prompt if the business hasn't written a noanswer one.
  if (isReclaimLeg) {
    return business.prompts['prompt-noanswer']
      || (isKnownCaller ? business.prompts['prompt-afterhours-known'] : business.prompts['prompt-afterhours-unknown']);
  }
  if (inHours && isKnownCaller)  return business.prompts['prompt-hours-known'];
  if (inHours && !isKnownCaller) return business.prompts['prompt-hours-unknown'];
  if (!inHours && isKnownCaller) return business.prompts['prompt-afterhours-known'];
  return business.prompts['prompt-afterhours-unknown'];
}

// A business can set its own opening line in config.json — "greeting" for unknown
// callers, "greetingKnown" (with a {firstName} placeholder) for recognised ones.
// Falls back to the generic wording when neither is set.
function buildFirstMessage(business, firstName) {
  const { greeting, greetingKnown, displayName } = business.config;
  if (firstName) {
    if (greetingKnown) return greetingKnown.replace(/\{firstName\}/g, firstName);
    if (greeting) return greeting;
    return `Hi ${firstName}, thanks for calling. How can I help?`;
  }
  if (greeting) return greeting;
  return `Hi there, you've called ${displayName}. How can I help you today?`;
}

// Opening line for the ring-reclaim leg — the caller has just heard ringing stop.
function buildReclaimFirstMessage(attemptedCallee, firstName) {
  const who = attemptedCallee || 'them';
  const name = firstName ? `${firstName}, ` : '';
  return `Sorry ${name}I couldn't get hold of ${who} just then. Can I take a message and have them call you back?`;
}

function resolveCallee(business, Callee_Name) {
  const calleeInfo = business.calleeDirectory[Callee_Name.toLowerCase()];
  if (!calleeInfo) {
    console.warn(`[Webhook] Callee not found: "${Callee_Name}" — using fallback email`);
  }
  return {
    toEmail: calleeInfo?.email || business.config.fallbackEmail || globalFallbackEmail,
    toNumber: calleeInfo?.phone,
    calleeRole: calleeInfo?.role || 'Unknown',
    found: !!calleeInfo
  };
}

function saveKnownCaller(business, phone, name) {
  if (!phone || !name) return;
  const normalPhone = phone.trim();
  const normalName = name.trim();
  if (!normalPhone || !normalName) return;
  if (isPlaceholderName(normalName)) return;
  if (business.knownCallers[normalPhone]) return; // first identification wins

  business.knownCallers[normalPhone] = normalName;
  fs.appendFileSync(business.knownCallersPath, `${normalPhone},${normalName}\n`, 'utf-8');
  console.log(`[KnownCallers] ${business.config.id}: ${normalPhone} → ${normalName}`);
  logInteraction(`Known caller saved (${business.config.id}): ${normalPhone} → ${normalName}`);
}

// ── Email & SMS ───────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: 'mail.smtp2go.com',
  port: 2525,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

async function sendEmail({ to, subject, body }) {
  await transporter.sendMail({ from: EMAIL_FROM, to, subject, text: body });
}

async function sendSms({ to, body }) {
  const response = await axios.post(
    'https://api.messagemedia.com/v1/messages',
    { messages: [{ content: body, destination_number: to, format: 'SMS' }] },
    {
      auth: { username: MESSAGEMEDIA_API_KEY, password: MESSAGEMEDIA_API_SECRET },
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    }
  );
  return response.data;
}

// ── Twilio call transfer ──────────────────────────────────────────────────────
// extraParams lets the ring-reclaim path pass mode/timeout/business/callee through
// to the /transfer TwiML endpoint, which decides between a blind <Dial> and a
// timed <Dial action=...> that hands the caller back to the agent on no-answer.
async function transferCall(callSid, toNumber, extraParams = {}) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_ACCOUNT_AUTH;
  const transferUrlBase = process.env.TRANSFER_URL_BASE;
  const query = new URLSearchParams({ to: toNumber, ...extraParams });
  const transferUrl = `${transferUrlBase}?${query.toString()}`;

  console.log(`[Twilio] Transfer URL: ${transferUrl}`);
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls/${callSid}.json`,
    new URLSearchParams({ Url: transferUrl, Method: 'POST' }),
    { auth: { username: twilioSid, password: twilioAuth } }
  );
  console.log(`[Twilio] Transfer initiated to ${toNumber} for call ${callSid}`);
}

// ── Call state ────────────────────────────────────────────────────────────────
// activeCallStore: call_sid → call context (populated by /incoming-call, enriched by webhooks)
// activeBridgeCalls: call_sid → bridge metadata (used to fill null system vars in webhooks)
// transcriptSent: set of call_sids for which transcript email has already been sent (dedup guard)
const activeCallStore = new Map();
const activeBridgeCalls = new Map();
const transcriptSent = new Set();

// pendingReclaim: call_sid → timestamp. Set while a ring-reclaim <Dial> is in flight.
// Redirecting the live call away from the media stream fires the WebSocket 'stop'
// event, which would otherwise send the transcript email and set the transcriptSent
// dedup flag — silently swallowing the message leg that follows on the SAME call_sid.
// While a sid is in this map, 'stop' skips the transcript; /dial-result clears it and
// owns the decision about when the transcript actually goes out.
const pendingReclaim = new Map();

setInterval(() => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [sid, data] of activeCallStore) {
    if (data.timestamp < twoHoursAgo) activeCallStore.delete(sid);
  }
  for (const [sid, data] of activeBridgeCalls) {
    if (data.timestamp < twoHoursAgo) activeBridgeCalls.delete(sid);
  }
  for (const [sid, ts] of pendingReclaim) {
    if (ts < twoHoursAgo) pendingReclaim.delete(sid);
  }
}, 30 * 60 * 1000);

// ElevenLabs sends 'None'/null for system variables over WebSocket.
// Fill missing values from stored bridge metadata.
function fillFromBridge(call_sid, fields) {
  const isBlank = v => !v || v === 'None' || v === 'null' || v === 'undefined';
  const bridge = !isBlank(call_sid) ? activeBridgeCalls.get(call_sid) : null;
  // Fallback: most recent bridge call overall (covers the null call_sid case)
  const fallback = bridge || [...activeBridgeCalls.values()].sort((a, b) => b.timestamp - a.timestamp)[0];
  if (fallback) {
    if (isBlank(fields.caller_id))    fields.caller_id    = fallback.caller_id;
    if (isBlank(fields.call_sid))     fields.call_sid     = fallback.call_sid;
    if (isBlank(fields.Caller_Phone)) fields.Caller_Phone = fallback.caller_id;
    console.log(`[Bridge] Filled: caller_id="${fields.caller_id}", call_sid="${fields.call_sid}"`);
  }
  return fields;
}

function storeCallContext(call_sid, businessId, Callee_Name, Caller_Name, Caller_Phone, caller_id) {
  if (call_sid) {
    activeCallStore.set(call_sid, {
      businessId,
      callee_name: Callee_Name,
      caller_name: Caller_Name,
      caller_phone: Caller_Phone || caller_id,
      timestamp: Date.now()
    });
  }
}

// ── Route handlers ────────────────────────────────────────────────────────────

// Twilio webhook: new incoming call
function handleIncomingCall(req, res) {
  const businessId = req.params.businessId || 'hdg';
  let business;
  try { business = getBusiness(businessId); }
  catch (e) { return res.status(404).send(`Unknown business: ${businessId}`); }

  const callerNumber = req.body.From || req.body.Caller || '';
  const callSid = req.body.CallSid || '';
  const knownName = business.knownCallers[callerNumber];

  console.log(`[Incoming:${businessId}] From ${callerNumber}${knownName ? ` (${knownName})` : ' (unknown)'}, SID: ${callSid}`);
  logInteraction(`Incoming call (${businessId}) from ${callerNumber}${knownName ? ` (${knownName})` : ' (unknown)'}`);

  // Store businessId immediately so /call-ended can look it up even without a transfer/message
  activeCallStore.set(callSid, { businessId, timestamp: Date.now() });

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const host = req.headers.host;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream?business=${esc(businessId)}">
      <Parameter name="caller_id" value="${esc(callerNumber)}" />
      <Parameter name="caller_name" value="${esc(knownName || '')}" />
      <Parameter name="call_sid" value="${esc(callSid)}" />
      <Parameter name="business_id" value="${esc(businessId)}" />
    </Stream>
  </Connect>
</Response>`;

  console.log(`[Incoming:${businessId}] Streaming to wss://${host}/media-stream?business=${businessId}`);
  res.set('Content-Type', 'text/xml').send(twiml);
}

// ElevenLabs webhook: transfer call to staff member
async function handleTransferCall(req, res) {
  try {
    let { Callee_Name, Caller_Name, Caller_Phone, caller_id, call_sid } = req.body;

    // Fill null/None system variables from bridge metadata first (needed to resolve businessId)
    ({ caller_id, call_sid, Caller_Phone } = fillFromBridge(call_sid, { caller_id, call_sid, Caller_Phone }));

    // Resolve businessId — prefer URL param, fall back to bridge data so legacy tool URLs work
    const isBlank = v => !v || v === 'None' || v === 'null' || v === 'undefined';
    let businessId = req.params.businessId;
    if (!businessId) {
      const bridge = !isBlank(call_sid) ? activeBridgeCalls.get(call_sid) : null;
      const latestBridge = bridge || [...activeBridgeCalls.values()].sort((a, b) => b.timestamp - a.timestamp)[0];
      businessId = latestBridge?.businessId || 'hdg';
    }
    const business = getBusiness(businessId);

    console.log(`[TransferCall:${businessId}] Payload:`, req.body);

    // Caller_Name is deliberately optional. Businesses that transfer immediately
    // (no "who's calling?" step) legitimately have no name yet — rejecting those
    // would fail every transfer and push every caller to voicemail.
    if (!Callee_Name) {
      console.error(`[TransferCall:${businessId}] Missing required field: Callee_Name`);
      return res.status(400).send('Missing required field: Callee_Name');
    }
    // Display-only. Never assign this back into Caller_Name: it would be stored as
    // the call's caller_name, and the ring-reclaim leg reads that back to build its
    // greeting — the caller gets addressed as "Unknown" for the rest of the call.
    const callerLabel = Caller_Name || 'Unknown caller';

    const { toEmail, toNumber, calleeRole } = resolveCallee(business, Callee_Name);

    // Ring-reclaim businesses ring for a fixed window and take a message on no-answer,
    // rather than blind-transferring and losing the caller to the callee's voicemail.
    const ringReclaim = business.config.transferMode === 'ring-reclaim';
    const ringTimeout = business.config.ringTimeout || 25;

    // Notify callee by email that a call is being transferred
    await sendEmail({
      to: toEmail,
      subject: `${business.config.receptionistName} — Incoming call from ${callerLabel}`,
      body: [
        `Callee: ${Callee_Name}`,
        `Callee Phone: ${toNumber || 'Unknown'}`,
        `Callee Role: ${calleeRole}`,
        '',
        `Caller Name: ${callerLabel}`,
        `Caller Phone: ${Caller_Phone}`,
        '',
        ringReclaim
          ? `Ringing you now for ~${ringTimeout}s. If you don't pick up, ${business.config.receptionistName} will take a message and email it to you.`
          : 'Call is being transferred now.',
        '',
        `Caller ID (Twilio): ${caller_id}`,
        `Call SID: ${call_sid}`
      ].join('\n')
    });
    console.log(`[TransferCall:${businessId}] Notification sent to ${toEmail}`);
    logInteraction(`[TransferCall:${businessId}] ${callerLabel} → ${Callee_Name} | to: ${toEmail} | SID: ${call_sid}`);

    storeCallContext(call_sid, businessId, Callee_Name, Caller_Name, Caller_Phone, caller_id);
    saveKnownCaller(business, Caller_Phone || caller_id, Caller_Name);

    // Attempt Twilio call transfer
    let transferStatus = 'not_attempted';
    let transferError = null;

    if (call_sid && toNumber) {
      try {
        if (ringReclaim) {
          // Mark before redirecting — the WebSocket 'stop' fires as soon as Twilio
          // pulls the call off the media stream, and must not send the transcript yet.
          pendingReclaim.set(call_sid, Date.now());
        }
        await transferCall(call_sid, toNumber, ringReclaim ? {
          mode: 'ring-reclaim',
          timeout: String(ringTimeout),
          business: businessId,
          callee: Callee_Name
        } : {});
        logInteraction(`[TransferCall:${businessId}] ${ringReclaim ? `Ring-reclaim dial (${ringTimeout}s)` : 'Transferred'} to ${toNumber}`);
        transferStatus = 'success';
      } catch (err) {
        if (ringReclaim) pendingReclaim.delete(call_sid);
        console.error(`[TransferCall:${businessId}] Twilio transfer failed:`, err.message);
        logInteraction(`[ERROR] Transfer failed (${businessId}): ${err.message}`);
        transferStatus = 'failed';
        transferError = err.message;
      }
    } else if (!toNumber) {
      transferStatus = 'failed';
      transferError = 'No phone number found for this staff member';
    }

    // In ring-reclaim mode the outcome isn't known yet — the dial is still ringing.
    // /dial-result sends the summary once Twilio reports how it actually ended, so
    // we don't email "TRANSFERRED SUCCESSFULLY" for a call that rang out.
    if (ringReclaim && transferStatus === 'success') {
      const existing = activeCallStore.get(call_sid) || {};
      activeCallStore.set(call_sid, {
        ...existing,
        callee_email: toEmail,
        callee_number: toNumber,
        callee_role: calleeRole,
        ring_timeout: ringTimeout
      });
      return res.status(200).json({
        status: 'ok',
        transfer_status: 'ringing',
        message: `Ringing ${Callee_Name} now. Stay silent while it rings — if they don't answer you will be reconnected to take a message.`
      });
    }

    // Send call summary to business email recipients
    const timestamp = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
    const statusLabel = transferStatus === 'success' ? 'TRANSFERRED SUCCESSFULLY' : 'TRANSFER FAILED';
    await sendEmail({
      to: business.config.emailRecipients,
      subject: `${business.config.receptionistName} Call Summary — ${callerLabel} → ${Callee_Name} [${statusLabel}]`,
      body: [
        `Call Summary — ${timestamp}`,
        '='.repeat(50),
        '',
        `Caller:       ${callerLabel}`,
        `Caller Phone: ${Caller_Phone || caller_id || 'Unknown'}`,
        '',
        `Requested:    ${Callee_Name}`,
        `Callee Phone: ${toNumber || 'Not in directory'}`,
        `Callee Email: ${toEmail}`,
        `Callee Role:  ${calleeRole}`,
        '',
        `Transfer:     ${statusLabel}`,
        ...(transferError ? [`Error:        ${transferError}`] : []),
        '',
        `Call SID:     ${call_sid || 'N/A'}`
      ].join('\n')
    }).catch(e => console.error(`[TransferCall:${businessId}] Summary email failed:`, e.message));

    res.status(200).json({
      status: 'ok',
      transfer_status: transferStatus,
      transfer_error: transferError,
      message: transferStatus === 'success'
        ? 'Call transfer initiated successfully.'
        : `Call transfer failed: ${transferError}. Please ask the caller if they would like to leave a message.`
    });
  } catch (err) {
    console.error('[Error] /transfer-call:', err.message);
    logInteraction(`[ERROR] /transfer-call: ${err.message}`);
    res.status(500).send('Failed to process transfer');
  }
}

// ElevenLabs webhook: take a message (after hours or failed transfer)
async function handleSendMessage(req, res) {
  try {
    let { Callee_Name, Caller_Name, Caller_Phone, Caller_Message, caller_id, call_sid } = req.body;

    // Fill null/None system variables from bridge metadata first (needed to resolve businessId)
    ({ caller_id, call_sid, Caller_Phone } = fillFromBridge(call_sid, { caller_id, call_sid, Caller_Phone }));

    // Resolve businessId — prefer URL param, fall back to bridge data so legacy tool URLs work
    const isBlank = v => !v || v === 'None' || v === 'null' || v === 'undefined';
    let businessId = req.params.businessId;
    if (!businessId) {
      const bridge = !isBlank(call_sid) ? activeBridgeCalls.get(call_sid) : null;
      const latestBridge = bridge || [...activeBridgeCalls.values()].sort((a, b) => b.timestamp - a.timestamp)[0];
      businessId = latestBridge?.businessId || 'hdg';
    }
    const business = getBusiness(businessId);

    console.log(`[SendMessage:${businessId}] Payload:`, req.body);

    // Same reasoning as /transfer-call: never lose a message over a missing name.
    if (!Callee_Name) {
      console.error(`[SendMessage:${businessId}] Missing required field: Callee_Name`);
      return res.status(400).send('Missing required field: Callee_Name');
    }
    // Display-only — see the note in handleTransferCall. Assigning it back into
    // Caller_Name would poison the stored call context with a fake name.
    const callerLabel = Caller_Name || 'Unknown caller';

    const { toEmail, toNumber, calleeRole } = resolveCallee(business, Callee_Name);

    await sendEmail({
      to: toEmail,
      subject: `${business.config.receptionistName} — New message for ${Callee_Name}`,
      body: [
        `Callee: ${Callee_Name}`,
        `Callee Phone: ${toNumber || 'Unknown'}`,
        `Callee Role: ${calleeRole}`,
        '',
        `Caller Name: ${callerLabel}`,
        `Caller Phone: ${Caller_Phone}`,
        `Caller Message: ${Caller_Message}`,
        '',
        `Caller ID (Twilio): ${caller_id}`,
        `Call SID: ${call_sid}`
      ].join('\n')
    });
    console.log(`[SendMessage:${businessId}] Message sent to ${toEmail}`);
    logInteraction(`[SendMessage:${businessId}] ${callerLabel} → ${Callee_Name} | "${Caller_Message}" | SID: ${call_sid}`);

    storeCallContext(call_sid, businessId, Callee_Name, Caller_Name, Caller_Phone, caller_id);
    saveKnownCaller(business, Caller_Phone || caller_id, Caller_Name);

    const timestamp = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
    await sendEmail({
      to: business.config.emailRecipients,
      subject: `${business.config.receptionistName} Call Summary — ${callerLabel} → ${Callee_Name} [MESSAGE TAKEN]`,
      body: [
        `Call Summary — ${timestamp}`,
        '='.repeat(50),
        '',
        `Caller:       ${callerLabel}`,
        `Caller Phone: ${Caller_Phone || caller_id || 'Unknown'}`,
        '',
        `Requested:    ${Callee_Name}`,
        `Callee Phone: ${toNumber || 'Not in directory'}`,
        `Callee Email: ${toEmail}`,
        `Callee Role:  ${calleeRole}`,
        '',
        `Message:      ${Caller_Message || 'None'}`,
        '',
        `Call SID:     ${call_sid || 'N/A'}`
      ].join('\n')
    }).catch(e => console.error(`[SendMessage:${businessId}] Summary email failed:`, e.message));

    res.status(200).json({
      status: 'ok',
      message_sent: true,
      message: 'Message has been delivered to the staff member. No transfer was attempted.'
    });
  } catch (err) {
    console.error('[Error] /send-message:', err.message);
    logInteraction(`[ERROR] /send-message: ${err.message}`);
    res.status(500).send('Failed to send message');
  }
}

// ElevenLabs webhook: send SMS to caller
async function handleSendText(req, res) {
  try {
    const businessId = req.params.businessId || 'hdg';
    const business = getBusiness(businessId);

    console.log(`[SendText:${businessId}] Payload:`, req.body);
    const { to_phone, message, caller_id } = req.body;
    const phone = to_phone || caller_id;

    if (!phone || !message) {
      return res.status(400).send('Missing required fields: to_phone (or caller_id) and message');
    }
    if (!MESSAGEMEDIA_API_KEY || !MESSAGEMEDIA_API_SECRET) {
      return res.status(500).send('SMS service not configured');
    }

    await sendSms({ to: phone, body: message });
    console.log(`[SendText:${businessId}] SMS sent to ${phone}`);
    logInteraction(`[SendText:${businessId}] SMS to ${phone}: ${message}`);

    const timestamp = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
    await sendEmail({
      to: business.config.emailRecipients,
      subject: `${business.config.receptionistName} SMS Sent to ${phone}`,
      body: [
        `SMS Sent — ${timestamp}`,
        '='.repeat(50),
        '',
        `To:        ${phone}`,
        `Message:   ${message}`,
        '',
        `Caller ID: ${caller_id || 'N/A'}`
      ].join('\n')
    }).catch(e => console.error(`[SendText:${businessId}] Summary email failed:`, e.message));

    res.status(200).json({ status: 'ok', sms_sent: true, message: 'Text message sent successfully.' });
  } catch (err) {
    console.error('[Error] /send-text:', err.message);
    logInteraction(`[ERROR] /send-text: ${err.message}`);
    res.status(200).json({
      status: 'error',
      sms_sent: false,
      message: `Failed to send text message: ${err.message}. Please apologise and let the caller know we were unable to text them.`
    });
  }
}

// ── HTTP endpoint registration ────────────────────────────────────────────────

// Business-specific routes — configure Twilio and ElevenLabs tools to use these
app.post('/incoming-call/:businessId', handleIncomingCall);
app.post('/transfer-call/:businessId', handleTransferCall);
app.post('/send-message/:businessId',  handleSendMessage);
app.post('/send-text/:businessId',     handleSendText);

// Legacy routes (no businessId) — default to 'hdg' for backward compatibility
// during transition while Twilio numbers and ElevenLabs tool URLs are being updated
app.post('/incoming-call', handleIncomingCall);
app.post('/transfer-call', handleTransferCall);
app.post('/send-message',  handleSendMessage);
app.post('/send-text',     handleSendText);

// Legacy /send-email alias — kept for backward compatibility
app.post('/send-email/:businessId', handleSendMessage);
app.post('/send-email',             handleSendMessage);

// Twilio TwiML endpoint: validates transfer number against all business staff directories
// Called by Twilio during an active transfer (URL set in TRANSFER_URL_BASE env var)
app.post('/transfer', (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).send('Missing "to" parameter');

  // Accept transfers to any number across all loaded businesses
  const allValidNumbers = new Set();
  for (const b of businesses.values()) {
    for (const num of b.validPhoneNumbers) allValidNumbers.add(num);
  }

  if (!allValidNumbers.has(to)) {
    console.warn(`[Transfer] Rejected transfer to unknown number: ${to}`);
    logInteraction(`[REJECTED] Transfer to unknown number: ${to}`);
    return res.status(403).send('Transfer number not in staff directory');
  }

  // Ring-reclaim mode: ring for a fixed window, then hand the caller back to the
  // agent instead of falling through to the callee's own voicemail. The action URL
  // fires on every dial outcome (answered-then-ended, no-answer, busy, failed).
  if (req.query.mode === 'ring-reclaim') {
    const timeout = Math.max(5, Math.min(120, parseInt(req.query.timeout || '25', 10) || 25));
    const businessId = req.query.business || 'hdg';
    const actionUrl = `https://${req.headers.host}/dial-result/${encodeURIComponent(businessId)}`
      + `?callee=${encodeURIComponent(req.query.callee || '')}`;

    const xml = `<Response><Dial timeout="${timeout}" action="${escXml(actionUrl)}" method="POST"><Number>${escXml(to)}</Number></Dial></Response>`;
    console.log(`[Transfer] Ring-reclaim TwiML (${timeout}s) for ${to}:`, xml);
    logInteraction(`Ring-reclaim dial (${businessId}) to ${to}, timeout ${timeout}s`);
    return res.set('Content-Type', 'text/xml').send(xml);
  }

  const xml = `<Response><Dial>${to}</Dial></Response>`;
  console.log('[Transfer] Returning TwiML:', xml);
  logInteraction(`Transfer XML generated for ${to}`);
  res.set('Content-Type', 'text/xml').send(xml);
});

// Twilio <Dial action> callback for ring-reclaim transfers.
// Fires on every dial outcome. On answer-then-hangup we're done; on no-answer/busy/
// failed we reconnect the caller to the agent in "couldn't reach them" mode rather
// than letting the call fall through to the callee's own voicemail.
app.post('/dial-result/:businessId', async (req, res) => {
  const businessId = req.params.businessId;
  const status = req.body.DialCallStatus;   // completed | no-answer | busy | failed | canceled
  const callSid = req.body.CallSid;
  const attemptedCallee = req.query.callee || '';

  console.log(`[DialResult:${businessId}] SID ${callSid} → DialCallStatus=${status}`);
  logInteraction(`[DialResult:${businessId}] ${callSid} → ${status} (callee: ${attemptedCallee || 'unknown'})`);

  pendingReclaim.delete(callSid);

  let business;
  try { business = getBusiness(businessId); }
  catch (e) {
    return res.set('Content-Type', 'text/xml')
      .send('<Response><Say>Sorry, something went wrong. Please call back shortly.</Say><Hangup/></Response>');
  }

  const callData = activeCallStore.get(callSid) || {};

  // Answered, and the two parties have now hung up — the call is over.
  // The WebSocket 'stop' was suppressed while the dial was in flight, so send
  // the transcript from here instead.
  if (status === 'completed') {
    const timestamp = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
    sendEmail({
      to: business.config.emailRecipients,
      subject: `${business.config.receptionistName} Call Summary — ${callData.caller_name || 'Unknown'} → ${attemptedCallee || callData.callee_name || 'Unknown'} [CONNECTED]`,
      body: [
        `Call Summary — ${timestamp}`,
        '='.repeat(50),
        '',
        `Caller:       ${callData.caller_name || 'Unknown'}`,
        `Caller Phone: ${callData.caller_phone || req.body.From || 'Unknown'}`,
        '',
        `Requested:    ${attemptedCallee || callData.callee_name || 'Unknown'}`,
        `Callee Phone: ${callData.callee_number || 'Unknown'}`,
        '',
        `Transfer:     CONNECTED — call answered and completed`,
        '',
        `Call SID:     ${callSid}`
      ].join('\n')
    }).catch(e => console.error(`[DialResult:${businessId}] Summary email failed:`, e.message));

    const durationSecs = callData.timestamp ? Math.floor((Date.now() - callData.timestamp) / 1000) : 60;
    sendTranscriptEmail(business, callSid, durationSecs, callData).catch(err =>
      console.error(`[DialResult:${businessId}] Transcript error:`, err.message)
    );

    return res.set('Content-Type', 'text/xml').send('<Response><Hangup/></Response>');
  }

  // No answer / busy / failed — hand the caller back to the agent to take a message.
  const callerNumber = callData.caller_phone || req.body.From || '';
  let knownName = callData.caller_name || business.knownCallers[callerNumber] || '';
  if (isPlaceholderName(knownName)) knownName = '';

  console.log(`[DialResult:${businessId}] Reclaiming call ${callSid} for ${knownName || 'unknown caller'}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream?business=${escXml(businessId)}">
      <Parameter name="caller_id" value="${escXml(callerNumber)}" />
      <Parameter name="caller_name" value="${escXml(knownName)}" />
      <Parameter name="call_sid" value="${escXml(callSid)}" />
      <Parameter name="business_id" value="${escXml(businessId)}" />
      <Parameter name="mode" value="noanswer" />
      <Parameter name="attempted_callee" value="${escXml(attemptedCallee)}" />
    </Stream>
  </Connect>
</Response>`;

  res.set('Content-Type', 'text/xml').send(twiml);
});

// ── Transcript helper ─────────────────────────────────────────────────────────
// Fetches the most recent ElevenLabs conversation and emails the transcript.
// Called from the WebSocket 'stop' event so it works without any Twilio callback config.
async function sendTranscriptEmail(business, callSid, callDurationSecs, callData) {
  if (!ELEVENLABS_API_KEY) return;
  if (transcriptSent.has(callSid)) return; // already sent — dedup guard
  transcriptSent.add(callSid);
  if (callDurationSecs < 5) {
    console.warn(`[Transcript] Call ${callSid} was only ${callDurationSecs}s — skipping`);
    return;
  }

  // Wait for ElevenLabs to finish processing the conversation
  await new Promise(resolve => setTimeout(resolve, 15000));

  const agentId = business.config.elevenLabsAgentId;
  const receptionistName = business.config.receptionistName;
  const logTag = `[Transcript:${business.config.id}]`;

  // A ring-reclaim call produces TWO ElevenLabs conversations on one CallSid: the
  // leg before the dial, and the message-taking leg after it rings out. The bridge
  // records each conversation_id as it starts, so we fetch them by ID and stitch
  // them together — picking "the most recent conversation" would drop leg one.
  let conversationIds = callData?.conversationIds || [];

  if (conversationIds.length === 0) {
    // No IDs captured (legacy path / bridge restarted) — fall back to discovery.
    const listResp = await axios.get(
      `https://api.elevenlabs.io/v1/convai/conversations`,
      { params: { agent_id: agentId, page_size: 10 }, headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );

    const conversations = listResp.data.conversations || [];
    if (conversations.length === 0) {
      console.warn(`${logTag} No conversations found for agent ${agentId}`);
      return;
    }

    const conv = conversations.find(c => c.status === 'done') || conversations[0];
    const convStartTime = conv.start_time_unix_secs || conv.created_at_unix_secs || 0;
    const nowSecs = Math.floor(Date.now() / 1000);
    if (convStartTime && (nowSecs - convStartTime) > 120) {
      console.warn(`${logTag} Most recent conversation is ${nowSecs - convStartTime}s old — skipping`);
      return;
    }
    conversationIds = [conv.conversation_id];
  }

  const segments = [];
  let totalDuration = 0;
  let analysis = {};

  for (const conversationId of conversationIds) {
    try {
      const convResp = await axios.get(
        `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
        { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
      );
      const conversation = convResp.data;
      const transcript = conversation.transcript || [];
      if (transcript.length === 0) {
        console.warn(`${logTag} Empty transcript for conversation ${conversationId}`);
        continue;
      }
      totalDuration += conversation.metadata?.call_duration_secs || 0;
      // Keep the last segment's analysis — it reflects how the call actually ended
      if (conversation.analysis) analysis = conversation.analysis;

      segments.push(transcript
        .filter(turn => turn.message && turn.message !== 'null')
        .map(turn => {
          const speaker = turn.role === 'agent' ? receptionistName : 'Caller';
          const timeStr = turn.time_in_call_secs != null ? `[${formatTime(turn.time_in_call_secs)}]` : '';
          return `${timeStr} ${speaker}: ${turn.message}`;
        }).join('\n\n'));
    } catch (err) {
      console.error(`${logTag} Failed to fetch conversation ${conversationId}:`, err.message);
    }
  }

  if (segments.length === 0) {
    console.warn(`${logTag} No transcript content for call ${callSid}`);
    return;
  }

  const formattedTranscript = segments.length === 1
    ? segments[0]
    : segments.map((s, i) => {
        const label = i === 0
          ? `--- Part ${i + 1} of ${segments.length} (before transfer attempt) ---`
          : `--- Part ${i + 1} of ${segments.length} (after no answer — taking a message) ---`;
        return `${label}\n\n${s}`;
      }).join('\n\n');

  const timestamp = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
  const callerInfo = callData?.caller_name
    ? `${callData.caller_name} (${callData.caller_phone})`
    : `Unknown (Call SID: ${callSid})`;
  const calleeInfo = callData?.callee_name || 'Unknown';
  const duration = totalDuration ? formatTime(totalDuration) : formatTime(callDurationSecs);

  await sendEmail({
    to: business.config.emailRecipients,
    subject: `${receptionistName} Call Transcript — ${callerInfo}`,
    body: [
      `Call Transcript — ${timestamp}`,
      '='.repeat(50),
      '',
      `Caller:    ${callerInfo}`,
      `Requested: ${calleeInfo}`,
      `Duration:  ${duration}`,
      `Call SID:  ${callSid}`,
      ...(analysis.call_successful != null ? [`Successful: ${analysis.call_successful}`] : []),
      ...(analysis.transcript_summary ? [`Summary: ${analysis.transcript_summary}`] : []),
      '',
      '='.repeat(50),
      'TRANSCRIPT',
      '='.repeat(50),
      '',
      formattedTranscript,
      '',
      '='.repeat(50),
      'End of transcript'
    ].join('\n')
  });
  console.log(`${logTag} Transcript emailed to ${business.config.emailRecipients.join(', ')}`);
  logInteraction(`Transcript for ${callSid} (${business.config.id}) emailed`);
}

// Twilio StatusCallback (optional): fires if phone number StatusCallback is configured in Twilio.
// Transcript is also sent from the WebSocket 'stop' event, so this is a backup only.
app.post('/call-ended', async (req, res) => {
  res.status(200).send('OK');

  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  if (!callSid || callStatus !== 'completed') return;

  const callDuration = parseInt(req.body.CallDuration || '0', 10);
  // Covers the caller-hung-up-mid-ring case: Twilio never requests the <Dial> action
  // URL, so /dial-result never runs and the flag would otherwise stay set forever.
  pendingReclaim.delete(callSid);
  const callData = activeCallStore.get(callSid);
  activeCallStore.delete(callSid);
  const businessId = callData?.businessId || 'hdg';
  let business;
  try { business = getBusiness(businessId); }
  catch (e) { return; }

  sendTranscriptEmail(business, callSid, callDuration, callData).catch(err =>
    console.error('[CallEnded] Transcript error:', err.message)
  );
});

// Reload a business's directory from disk without restarting the server
app.post('/reload-directory/:businessId', (req, res) => {
  const { businessId } = req.params;
  try {
    businesses.set(businessId, loadBusiness(businessId));
    const b = businesses.get(businessId);
    const msg = `Reloaded "${businessId}": ${Object.keys(b.calleeDirectory).length} callees, ${Object.keys(b.knownCallers).length} known callers`;
    console.log(`[Reload] ${msg}`);
    logInteraction(`[Reload] ${msg}`);
    res.status(200).send(msg);
  } catch (err) {
    console.error('[Reload] Failed:', err.message);
    res.status(500).send(`Failed to reload ${businessId}: ${err.message}`);
  }
});

// Reload all businesses
app.post('/reload-directory', (req, res) => {
  try {
    const ids = [...businesses.keys()];
    for (const id of ids) businesses.set(id, loadBusiness(id));
    const msg = `Reloaded all businesses: ${ids.join(', ')}`;
    console.log(`[Reload] ${msg}`);
    res.status(200).send(msg);
  } catch (err) {
    console.error('[Reload] Failed:', err.message);
    res.status(500).send('Failed to reload directories');
  }
});

// Health check
app.get('/health', (req, res) => {
  const status = {};
  for (const [id, b] of businesses) {
    status[id] = {
      callees: Object.keys(b.calleeDirectory).length,
      known_callers: Object.keys(b.knownCallers).length,
      agent_id: b.config.elevenLabsAgentId
    };
  }
  res.status(200).json({ status: 'ok', businesses: status, uptime: process.uptime() });
});

app.get('/', (req, res) => {
  res.status(200).send(`AI Receptionist — ${[...businesses.keys()].join(', ')} — Running`);
});

// Diagnostic: send a test email to verify SMTP is working
// Usage: GET /test-email?to=you@example.com
app.get('/test-email', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).send('Missing ?to= parameter');
  try {
    await sendEmail({
      to,
      subject: 'AI Receptionist — SMTP test',
      body: `SMTP test sent at ${new Date().toISOString()}`
    });
    res.status(200).send(`Test email sent to ${to}`);
  } catch (err) {
    res.status(500).send(`SMTP error: ${err.message}`);
  }
});

// ── Audio format conversion: Twilio (mulaw 8kHz) <-> ElevenLabs (PCM 16-bit 16kHz) ──

const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let v = ~i & 0xFF;
  const sign = v & 0x80;
  const exponent = (v >> 4) & 0x07;
  const mantissa = v & 0x0F;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  MULAW_DECODE[i] = sign ? -sample : sample;
}

function linearToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const expLut = [0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3,
                  4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,
                  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
                  5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,
                  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
                  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
                  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
                  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
                  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
                  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
                  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
                  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
                  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
                  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
                  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,
                  7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7];
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  const exponent = expLut[(sample >> 7) & 0xFF];
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

function mulawToPcm16k(mulawBuf) {
  const pcmBuf = Buffer.alloc(mulawBuf.length * 4);
  for (let i = 0; i < mulawBuf.length; i++) {
    const sample = MULAW_DECODE[mulawBuf[i]];
    pcmBuf.writeInt16LE(sample, i * 4);
    pcmBuf.writeInt16LE(sample, i * 4 + 2);
  }
  return pcmBuf;
}

function pcm16kToMulaw(pcmBuf) {
  const numSamples = pcmBuf.length / 2;
  const mulawBuf = Buffer.alloc(Math.floor(numSamples / 2));
  for (let i = 0; i < mulawBuf.length; i++) {
    const sample = pcmBuf.readInt16LE(i * 4);
    mulawBuf[i] = linearToMulaw(sample);
  }
  return mulawBuf;
}

// ── WebSocket bridge: Twilio <-> ElevenLabs ───────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/media-stream' });

async function getSignedUrl(agentId) {
  const resp = await axios.get(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
    { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
  );
  return resp.data.signed_url;
}

// WebSocket connection handler.
// IMPORTANT: Azure App Service's ARR proxy strips query parameters from WebSocket upgrade
// URLs, so we cannot rely on ?business=hdg from the URL alone. Instead, business_id is
// also sent as a Twilio <Stream> custom parameter and resolved from the 'start' event.
wss.on('connection', (twilioWs, req) => {
  const urlParams = new URL(req.url, 'http://localhost').searchParams;
  const businessIdFromUrl = urlParams.get('business'); // may be null if stripped by ARR

  // business and businessId are resolved in the 'start' event handler below
  let business = null;
  let businessId = businessIdFromUrl || 'pending';

  console.log(`[WS] Twilio connected, URL business param: ${businessIdFromUrl || 'none (will use stream param)'}`);

  let streamSid = null;
  let elevenLabsWs = null;
  let elevenLabsReady = false;
  let audioQueue = [];
  let callStartTime = null;
  let wsCallSid = null;

  async function connectToElevenLabs(customParameters) {
    try {
      const agentId = business.config.elevenLabsAgentId;
      const signedUrl = await getSignedUrl(agentId);
      console.log(`[WS:${businessId}] Got signed URL, connecting to ElevenLabs (agent: ${agentId})...`);

      elevenLabsWs = new WebSocket(signedUrl);

      elevenLabsWs.on('open', () => {
        console.log(`[WS:${businessId}] Connected to ElevenLabs`);

        const callSid    = customParameters.call_sid  || '';
        const callerId   = customParameters.caller_id || '';
        const callerName = customParameters.caller_name || '';
        // Last line of defence: a placeholder here would be greeted as a real name
        // and asserted in the [CALLER CONTEXT] block for the whole call.
        const callerNameSafe = isPlaceholderName(callerName) ? '' : callerName;
        const firstName  = callerNameSafe ? callerNameSafe.split(' ')[0] : '';

        // Store bridge metadata keyed by call_sid so webhooks can fill null system vars
        const bridgeKey = callSid || `bridge-${Date.now()}`;
        activeBridgeCalls.set(bridgeKey, {
          caller_id: callerId,
          call_sid: callSid,
          caller_name: callerNameSafe,
          businessId,
          timestamp: Date.now()
        });

        // Reclaim leg: this call already rang the callee and they didn't pick up.
        // Set by /dial-result, never by the LLM.
        const isReclaimLeg = customParameters.mode === 'noanswer';
        const attemptedCallee = customParameters.attempted_callee || '';

        // Select prompt based on time of day and whether caller is known
        const isKnownCaller = !!firstName;
        const basePrompt = selectPrompt(business, isKnownCaller, isReclaimLeg);
        const knowledgeAppendix = business.knowledge
          ? `\n\n---\n\n# Knowledge Base\n\n${business.knowledge}`
          : '';
        const systemPrompt = basePrompt + knowledgeAppendix;
        const firstMessage = isReclaimLeg
          ? buildReclaimFirstMessage(attemptedCallee, firstName)
          : buildFirstMessage(business, firstName);

        // Prepend caller context block so the LLM can't forget it already has the name
        let callerContextBlock = firstName
          ? `[CALLER CONTEXT — THIS TAKES PRIORITY: The caller has been identified. Their full name is "${callerNameSafe}". You have already greeted them as "${firstName}" in your opening message. Do NOT ask for their name at any point during this call.]\n\n`
          : '';

        if (isReclaimLeg) {
          callerContextBlock += `[CALL STATE — THIS TAKES PRIORITY: You already spoke with this caller earlier in this same call. You attempted to connect them to ${attemptedCallee || 'the person they asked for'} and the phone rang out unanswered. You have ALREADY apologised for that in your opening message. Do NOT greet them again, do NOT ask who they want to speak to, and do NOT attempt another transfer. Your only job now is to take a message and send it. ${firstName ? `Their name is "${callerNameSafe}" — do not ask for it again.` : 'Ask for their name if you do not have it.'}]\n\n`;
        }

        const agentOverride = { first_message: firstMessage };
        if (systemPrompt) {
          agentOverride.prompt = { prompt: callerContextBlock + systemPrompt };
        }

        const initMessage = {
          type: 'conversation_initiation_client_data',
          conversation_config_override: { agent: agentOverride },
          custom_llm_extra_body: { caller_name: callerNameSafe, caller_id: callerId }
        };

        elevenLabsWs.send(JSON.stringify(initMessage));
        console.log(`[WS:${businessId}] Sent init — caller="${callerNameSafe || 'unknown'}", inHours=${isBusinessHours(business.config)}, known=${isKnownCaller}`);

        elevenLabsReady = true;
        for (const chunk of audioQueue) {
          elevenLabsWs.send(JSON.stringify({ user_audio_chunk: chunk }));
        }
        audioQueue = [];
      });

      elevenLabsWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          switch (msg.type) {
            case 'conversation_initiation_metadata': {
              // Record the conversation id against the CallSid. A ring-reclaim call
              // produces one id per leg; sendTranscriptEmail stitches them together.
              const convId = msg.conversation_initiation_metadata_event?.conversation_id;
              console.log(`[WS:${businessId}] ElevenLabs conversation initiated${convId ? ` (${convId})` : ''}`);
              if (convId && wsCallSid) {
                const entry = activeCallStore.get(wsCallSid) || { businessId, timestamp: Date.now() };
                entry.conversationIds = [...(entry.conversationIds || []), convId];
                activeCallStore.set(wsCallSid, entry);
              }
              break;
            }
            case 'audio':
              if (msg.audio_event?.audio_base_64) {
                const pcmBuf  = Buffer.from(msg.audio_event.audio_base_64, 'base64');
                const mulawBuf = pcm16kToMulaw(pcmBuf);
                twilioWs.send(JSON.stringify({
                  event: 'media',
                  streamSid,
                  media: { payload: mulawBuf.toString('base64') }
                }));
              }
              break;
            case 'interruption':
              twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
              break;
            case 'ping':
              if (msg.ping_event?.event_id) {
                elevenLabsWs.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event.event_id }));
              }
              break;
          }
        } catch (err) {
          console.error(`[WS:${businessId}] Error handling ElevenLabs message:`, err.message);
        }
      });

      elevenLabsWs.on('error', err => console.error(`[WS:${businessId}] ElevenLabs error:`, err.message));
      elevenLabsWs.on('close', () => console.log(`[WS:${businessId}] ElevenLabs disconnected`));

    } catch (err) {
      console.error(`[WS:${businessId}] Failed to connect to ElevenLabs:`, err.message);
      twilioWs.close();
    }
  }

  twilioWs.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      switch (data.event) {
        case 'start':
          streamSid = data.start.streamSid;
          callStartTime = Date.now();
          const customParameters = data.start.customParameters || {};
          wsCallSid = customParameters.call_sid || null;

          // Resolve business here — stream params are reliable (message body, not URL).
          // URL query param is preferred if present; stream param is the reliable fallback.
          businessId = businessIdFromUrl || customParameters.business_id || 'hdg';
          try {
            business = getBusiness(businessId);
          } catch (e) {
            console.error(`[WS] Unknown business "${businessId}" — closing connection`);
            twilioWs.close();
            return;
          }

          console.log(`[WS:${businessId}] Stream started, SID: ${streamSid}, caller: ${customParameters.caller_name || 'unknown'}`);
          connectToElevenLabs(customParameters);
          break;
        case 'media':
          const mulawIn = Buffer.from(data.media.payload, 'base64');
          const pcmOut  = mulawToPcm16k(mulawIn);
          const pcmB64  = pcmOut.toString('base64');
          if (elevenLabsReady && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({ user_audio_chunk: pcmB64 }));
          } else {
            audioQueue.push(pcmB64);
          }
          break;
        case 'stop':
          console.log(`[WS:${businessId}] Twilio stream stopped`);
          if (elevenLabsWs) elevenLabsWs.close();
          // A ring-reclaim dial is in flight: this 'stop' is Twilio pulling the call
          // off the stream to ring the callee, not the call ending. Sending the
          // transcript now would set the dedup flag and swallow the message leg.
          if (wsCallSid && pendingReclaim.has(wsCallSid)) {
            console.log(`[WS:${businessId}] Stream stopped for ring-reclaim dial — deferring transcript to /dial-result`);
            break;
          }
          if (business && wsCallSid && callStartTime) {
            // Span the whole call, not just this leg, when we know when it started
            const storedStart = activeCallStore.get(wsCallSid)?.timestamp;
            const callDuration = Math.floor((Date.now() - (storedStart || callStartTime)) / 1000);
            const callData = activeCallStore.get(wsCallSid);
            sendTranscriptEmail(business, wsCallSid, callDuration, callData).catch(err =>
              console.error(`[WS:${businessId}] Transcript error:`, err.message)
            );
          }
          break;
      }
    } catch (err) {
      console.error(`[WS:${businessId}] Error handling Twilio message:`, err.message);
    }
  });

  twilioWs.on('close', () => {
    console.log(`[WS:${businessId}] Twilio disconnected`);
    if (elevenLabsWs) elevenLabsWs.close();
  });

  twilioWs.on('error', err => {
    console.error(`[WS:${businessId}] Twilio error:`, err.message);
    if (elevenLabsWs) elevenLabsWs.close();
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[Startup] Listening on port ${PORT}`);
  console.log(`[Startup] Businesses loaded: ${[...businesses.keys()].join(', ')}`);
  logInteraction(`Server started on port ${PORT} — businesses: ${[...businesses.keys()].join(', ')}`);
});
