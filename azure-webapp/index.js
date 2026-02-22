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

  const validPhoneNumbers = new Set(
    Object.values(calleeDirectory).map(e => e.phone).filter(Boolean)
  );

  return { config, calleeDirectory, knownCallers, knownCallersPath, prompts, validPhoneNumbers };
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
function selectPrompt(business, isKnownCaller) {
  const inHours = isBusinessHours(business.config);
  if (inHours && isKnownCaller)  return business.prompts['prompt-hours-known'];
  if (inHours && !isKnownCaller) return business.prompts['prompt-hours-unknown'];
  if (!inHours && isKnownCaller) return business.prompts['prompt-afterhours-known'];
  return business.prompts['prompt-afterhours-unknown'];
}

function buildFirstMessage(business, firstName) {
  if (firstName) {
    return `Hi ${firstName}, thanks for calling. How can I help?`;
  }
  return `Hi there, you've called ${business.config.displayName}. How can I help you today?`;
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
async function transferCall(callSid, toNumber) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_ACCOUNT_AUTH;
  const transferUrlBase = process.env.TRANSFER_URL_BASE;
  const transferUrl = `${transferUrlBase}?to=${encodeURIComponent(toNumber)}`;

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
const activeCallStore = new Map();
const activeBridgeCalls = new Map();

setInterval(() => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [sid, data] of activeCallStore) {
    if (data.timestamp < twoHoursAgo) activeCallStore.delete(sid);
  }
  for (const [sid, data] of activeBridgeCalls) {
    if (data.timestamp < twoHoursAgo) activeBridgeCalls.delete(sid);
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
    const businessId = req.params.businessId || 'hdg';
    const business = getBusiness(businessId);

    console.log(`[TransferCall:${businessId}] Payload:`, req.body);
    let { Callee_Name, Caller_Name, Caller_Phone, caller_id, call_sid } = req.body;

    ({ caller_id, call_sid, Caller_Phone } = fillFromBridge(call_sid, { caller_id, call_sid, Caller_Phone }));

    if (!Callee_Name || !Caller_Name) {
      console.error(`[TransferCall:${businessId}] Missing required fields:`, { Callee_Name, Caller_Name });
      return res.status(400).send('Missing required fields: Callee_Name, Caller_Name');
    }

    const { toEmail, toNumber, calleeRole } = resolveCallee(business, Callee_Name);

    // Notify callee by email that a call is being transferred
    await sendEmail({
      to: toEmail,
      subject: `${business.config.receptionistName} — Incoming call from ${Caller_Name}`,
      body: [
        `Callee: ${Callee_Name}`,
        `Callee Phone: ${toNumber || 'Unknown'}`,
        `Callee Role: ${calleeRole}`,
        '',
        `Caller Name: ${Caller_Name}`,
        `Caller Phone: ${Caller_Phone}`,
        '',
        'Call is being transferred now.',
        '',
        `Caller ID (Twilio): ${caller_id}`,
        `Call SID: ${call_sid}`
      ].join('\n')
    });
    console.log(`[TransferCall:${businessId}] Notification sent to ${toEmail}`);
    logInteraction(`[TransferCall:${businessId}] ${Caller_Name} → ${Callee_Name} | to: ${toEmail} | SID: ${call_sid}`);

    storeCallContext(call_sid, businessId, Callee_Name, Caller_Name, Caller_Phone, caller_id);
    saveKnownCaller(business, Caller_Phone || caller_id, Caller_Name);

    // Attempt Twilio call transfer
    let transferStatus = 'not_attempted';
    let transferError = null;

    if (call_sid && toNumber) {
      try {
        await transferCall(call_sid, toNumber);
        logInteraction(`[TransferCall:${businessId}] Transferred to ${toNumber}`);
        transferStatus = 'success';
      } catch (err) {
        console.error(`[TransferCall:${businessId}] Twilio transfer failed:`, err.message);
        logInteraction(`[ERROR] Transfer failed (${businessId}): ${err.message}`);
        transferStatus = 'failed';
        transferError = err.message;
      }
    } else if (!toNumber) {
      transferStatus = 'failed';
      transferError = 'No phone number found for this staff member';
    }

    // Send call summary to business email recipients
    const timestamp = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
    const statusLabel = transferStatus === 'success' ? 'TRANSFERRED SUCCESSFULLY' : 'TRANSFER FAILED';
    await sendEmail({
      to: business.config.emailRecipients,
      subject: `${business.config.receptionistName} Call Summary — ${Caller_Name} → ${Callee_Name} [${statusLabel}]`,
      body: [
        `Call Summary — ${timestamp}`,
        '='.repeat(50),
        '',
        `Caller:       ${Caller_Name}`,
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
    const businessId = req.params.businessId || 'hdg';
    const business = getBusiness(businessId);

    console.log(`[SendMessage:${businessId}] Payload:`, req.body);
    let { Callee_Name, Caller_Name, Caller_Phone, Caller_Message, caller_id, call_sid } = req.body;

    ({ caller_id, call_sid, Caller_Phone } = fillFromBridge(call_sid, { caller_id, call_sid, Caller_Phone }));

    if (!Callee_Name || !Caller_Name) {
      console.error(`[SendMessage:${businessId}] Missing required fields:`, { Callee_Name, Caller_Name });
      return res.status(400).send('Missing required fields: Callee_Name, Caller_Name');
    }

    const { toEmail, toNumber, calleeRole } = resolveCallee(business, Callee_Name);

    await sendEmail({
      to: toEmail,
      subject: `${business.config.receptionistName} — New message for ${Callee_Name}`,
      body: [
        `Callee: ${Callee_Name}`,
        `Callee Phone: ${toNumber || 'Unknown'}`,
        `Callee Role: ${calleeRole}`,
        '',
        `Caller Name: ${Caller_Name}`,
        `Caller Phone: ${Caller_Phone}`,
        `Caller Message: ${Caller_Message}`,
        '',
        `Caller ID (Twilio): ${caller_id}`,
        `Call SID: ${call_sid}`
      ].join('\n')
    });
    console.log(`[SendMessage:${businessId}] Message sent to ${toEmail}`);
    logInteraction(`[SendMessage:${businessId}] ${Caller_Name} → ${Callee_Name} | "${Caller_Message}" | SID: ${call_sid}`);

    storeCallContext(call_sid, businessId, Callee_Name, Caller_Name, Caller_Phone, caller_id);
    saveKnownCaller(business, Caller_Phone || caller_id, Caller_Name);

    const timestamp = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
    await sendEmail({
      to: business.config.emailRecipients,
      subject: `${business.config.receptionistName} Call Summary — ${Caller_Name} → ${Callee_Name} [MESSAGE TAKEN]`,
      body: [
        `Call Summary — ${timestamp}`,
        '='.repeat(50),
        '',
        `Caller:       ${Caller_Name}`,
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

  const xml = `<Response><Dial>${to}</Dial></Response>`;
  console.log('[Transfer] Returning TwiML:', xml);
  logInteraction(`Transfer XML generated for ${to}`);
  res.set('Content-Type', 'text/xml').send(xml);
});

// Twilio StatusCallback: fetches ElevenLabs transcript and emails it to the business
app.post('/call-ended', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  res.status(200).send('OK'); // respond immediately so Twilio doesn't retry

  if (!callSid || callStatus !== 'completed') return;

  const callDuration = parseInt(req.body.CallDuration || '0', 10);
  console.log(`[CallEnded] Call ${callSid} completed, duration: ${callDuration}s`);

  if (callDuration < 5) {
    console.warn(`[CallEnded] Call ${callSid} was only ${callDuration}s — skipping transcript`);
    return;
  }

  // Look up business from the call record stored in /incoming-call
  const callData = activeCallStore.get(callSid);
  activeCallStore.delete(callSid);

  const businessId = callData?.businessId || 'hdg';
  let business;
  try { business = getBusiness(businessId); }
  catch (e) {
    console.error(`[CallEnded] Unknown business "${businessId}" for call ${callSid}`);
    return;
  }

  if (!ELEVENLABS_API_KEY) {
    console.warn('[CallEnded] ELEVENLABS_API_KEY not set — skipping transcript');
    return;
  }

  // Wait for ElevenLabs to finish processing the conversation
  await new Promise(resolve => setTimeout(resolve, 15000));

  try {
    const agentId = business.config.elevenLabsAgentId;
    const receptionistName = business.config.receptionistName;

    const listResp = await axios.get(
      `https://api.elevenlabs.io/v1/convai/conversations`,
      { params: { agent_id: agentId, page_size: 10 }, headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );

    const conversations = listResp.data.conversations || [];
    if (conversations.length === 0) {
      console.warn(`[CallEnded] No conversations found for agent ${agentId}`);
      return;
    }

    const conv = conversations.find(c => c.status === 'done') || conversations[0];
    const conversationId = conv.conversation_id;
    const convStartTime = conv.start_time_unix_secs || conv.created_at_unix_secs || 0;
    const nowSecs = Math.floor(Date.now() / 1000);
    if (convStartTime && (nowSecs - convStartTime) > 120) {
      console.warn(`[CallEnded] Most recent conversation is ${nowSecs - convStartTime}s old — skipping`);
      return;
    }

    const convResp = await axios.get(
      `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );

    const conversation = convResp.data;
    const transcript = conversation.transcript || [];

    if (transcript.length === 0) {
      console.warn(`[CallEnded] Empty transcript for conversation ${conversationId}`);
      return;
    }

    const formattedTranscript = transcript
      .filter(turn => turn.message && turn.message !== 'null')
      .map(turn => {
        const speaker = turn.role === 'agent' ? receptionistName : 'Caller';
        const timeStr = turn.time_in_call_secs != null ? `[${formatTime(turn.time_in_call_secs)}]` : '';
        return `${timeStr} ${speaker}: ${turn.message}`;
      }).join('\n\n');

    const timestamp = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
    const callerInfo = callData?.caller_name
      ? `${callData.caller_name} (${callData.caller_phone})`
      : req.body.From || `Unknown (Call SID: ${callSid})`;
    const calleeInfo = callData?.callee_name || 'Unknown';
    const analysis = conversation.analysis || {};
    const duration = conv.call_duration_secs
      ? formatTime(conv.call_duration_secs)
      : req.body.CallDuration ? formatTime(parseInt(req.body.CallDuration)) : 'Unknown';

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
    console.log(`[CallEnded] Transcript emailed to ${business.config.emailRecipients.join(', ')}`);
    logInteraction(`Transcript for ${callSid} (${businessId}) emailed`);
  } catch (err) {
    console.error('[CallEnded] Failed to fetch/send transcript:', err.message);
    logInteraction(`[ERROR] Transcript failed for ${callSid}: ${err.message}`);
  }
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

// WebSocket connection handler — receives businessId from query param: /media-stream?business=hdg
wss.on('connection', (twilioWs, req) => {
  const urlParams = new URL(req.url, 'http://localhost').searchParams;
  const businessId = urlParams.get('business') || 'hdg';

  let business;
  try { business = getBusiness(businessId); }
  catch (e) {
    console.error(`[WS] Unknown business "${businessId}" — closing connection`);
    twilioWs.close();
    return;
  }

  console.log(`[WS:${businessId}] Twilio connected to media stream`);

  let streamSid = null;
  let elevenLabsWs = null;
  let elevenLabsReady = false;
  let audioQueue = [];

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
        const firstName  = callerName ? callerName.split(' ')[0] : '';

        // Store bridge metadata keyed by call_sid so webhooks can fill null system vars
        const bridgeKey = callSid || `bridge-${Date.now()}`;
        activeBridgeCalls.set(bridgeKey, {
          caller_id: callerId,
          call_sid: callSid,
          caller_name: callerName,
          businessId,
          timestamp: Date.now()
        });

        // Select prompt based on time of day and whether caller is known
        const isKnownCaller = !!firstName;
        const systemPrompt = selectPrompt(business, isKnownCaller);
        const firstMessage = buildFirstMessage(business, firstName);

        // Prepend caller context block so the LLM can't forget it already has the name
        const callerContextBlock = firstName
          ? `[CALLER CONTEXT — THIS TAKES PRIORITY: The caller has been identified. Their full name is "${callerName}". You have already greeted them as "${firstName}" in your opening message. Do NOT ask for their name at any point during this call.]\n\n`
          : '';

        const agentOverride = { first_message: firstMessage };
        if (systemPrompt) {
          agentOverride.prompt = { prompt: callerContextBlock + systemPrompt };
        }

        const initMessage = {
          type: 'conversation_initiation_client_data',
          conversation_config_override: { agent: agentOverride },
          custom_llm_extra_body: { caller_name: callerName, caller_id: callerId }
        };

        elevenLabsWs.send(JSON.stringify(initMessage));
        console.log(`[WS:${businessId}] Sent init — caller="${callerName || 'unknown'}", inHours=${isBusinessHours(business.config)}, known=${isKnownCaller}`);

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
            case 'conversation_initiation_metadata':
              console.log(`[WS:${businessId}] ElevenLabs conversation initiated`);
              break;
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
          const customParameters = data.start.customParameters || {};
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
