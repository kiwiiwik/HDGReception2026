// index.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 8080;
const calleeListPath = path.join(__dirname, 'callee_list.txt');
const fallbackEmail = process.env.FALLBACK_EMAIL || 'rod.grant@i6.co.nz';
const notifyEmail = 'rod.grant@hdg.co.nz';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = 'agent_01jysz8r0bejrvx2d9wv8gckca';

// In-memory store for active calls (call_sid → call context)
const activeCallStore = new Map();

// Clean up stale entries older than 2 hours
setInterval(() => {
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [sid, data] of activeCallStore) {
    if (data.timestamp < twoHoursAgo) activeCallStore.delete(sid);
  }
}, 30 * 60 * 1000);

// Format seconds as m:ss
function formatTime(secs) {
  const mins = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${mins}:${s.toString().padStart(2, '0')}`;
}

// Setup logs directory
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Logger function
function logInteraction(entry) {
  const timestamp = new Date().toISOString();
  const date = timestamp.split('T')[0];
  const logFilePath = path.join(logDir, `agent-${date}.log`);
  const logLine = `[${timestamp}] ${entry}\n`;

  fs.appendFile(logFilePath, logLine, (err) => {
    if (err) console.error('[Logger] Failed to write log:', err.message);
  });
}

// Load callee directory into memory once at startup
function loadCalleeDirectory() {
  const data = fs.readFileSync(calleeListPath, 'utf-8');
  const lines = data.split('\n').filter(line => line.trim() !== '');
  const directory = {};
  lines.forEach(line => {
    const [name, email, phone, role] = line.split(',').map(x => x.trim());
    if (name && name.toLowerCase() !== 'name') {
      directory[name.toLowerCase()] = { name, email, phone, role };
    }
  });
  return directory;
}

let calleeDirectory = loadCalleeDirectory();
console.log(`[Startup] Loaded ${Object.keys(calleeDirectory).length} callee entries`);

// Build a set of valid phone numbers for transfer validation
function getValidPhoneNumbers() {
  const valid = new Set();
  for (const entry of Object.values(calleeDirectory)) {
    if (entry.phone) valid.add(entry.phone);
  }
  return valid;
}

let validPhoneNumbers = getValidPhoneNumbers();

// Reusable SMTP transporter
const transporter = nodemailer.createTransport({
  host: 'mail.smtp2go.com',
  port: 2525,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Email sender
async function sendEmail({ to, subject, body }) {
  await transporter.sendMail({
    from: '"AI Receptionist" <ai@hdg.co.nz>',
    to,
    subject,
    text: body
  });
}

// Call transfer via Twilio REST API
async function transferCall(callSid, toNumber) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_ACCOUNT_AUTH;
  const transferUrlBase = process.env.TRANSFER_URL_BASE;

  const transferUrl = `${transferUrlBase}?to=${encodeURIComponent(toNumber)}`;
  console.log(`[Twilio] Transfer URL: ${transferUrl}`);

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls/${callSid}.json`;

  try {
    const response = await axios.post(
      endpoint,
      new URLSearchParams({
        Url: transferUrl,
        Method: 'POST'
      }),
      {
        auth: {
          username: twilioSid,
          password: twilioAuth
        }
      }
    );
    console.log('[Twilio] Call transfer response:', response.data);
  } catch (err) {
    console.error(`[Twilio] Transfer failed for call ${callSid}:`, err.message);
    logInteraction(`[ERROR] Twilio transfer failed for ${callSid}: ${err.message}`);
    throw err;
  }
}

// Webhook: /send-email
app.post('/send-email', async (req, res) => {
  try {
    console.log('[Webhook] Payload:', req.body);
    const {
      Callee_Name,
      Caller_Name,
      Caller_Phone,
      Caller_Message,
      caller_id,
      call_sid
    } = req.body;

    if (!Callee_Name || !Caller_Name) {
      console.error('[Webhook] Missing required fields:', { Callee_Name, Caller_Name });
      return res.status(400).send('Missing required fields: Callee_Name, Caller_Name');
    }

    const calleeInfo = calleeDirectory[Callee_Name.toLowerCase()];
    const toEmail = calleeInfo?.email || fallbackEmail;
    const toNumber = calleeInfo?.phone;
    const calleeRole = calleeInfo?.role || 'Unknown';

    if (!calleeInfo) {
      console.warn(`[Webhook] Callee not found in directory: "${Callee_Name}", using fallback email`);
    }

    const subject = `ABACUS New message for ${Callee_Name}`;
    const body = `
Callee: ${Callee_Name}
Callee Phone: ${toNumber || 'Unknown'}
Callee Role: ${calleeRole}

Caller Name: ${Caller_Name}
Caller Phone: ${Caller_Phone}
Caller Message: ${Caller_Message}

Caller ID (from Twilio): ${caller_id}
Call SID: ${call_sid}
`.trim();

    await sendEmail({ to: toEmail, subject, body });
    console.log(`[Email] Message sent to ${toEmail}`);

    const logEntry = `
Interaction:
Callee: ${Callee_Name}
Caller: ${Caller_Name}
Caller Phone: ${Caller_Phone}
Message: ${Caller_Message}
Sent to: ${toEmail}
Call SID: ${call_sid}
`;
    logInteraction(logEntry.trim());

    // Store call context for transcript retrieval later
    if (call_sid) {
      activeCallStore.set(call_sid, {
        callee_name: Callee_Name,
        caller_name: Caller_Name,
        caller_phone: Caller_Phone || caller_id,
        timestamp: Date.now()
      });
    }

    let transferStatus = 'not_attempted';
    let transferError = null;

    if (call_sid && toNumber) {
      try {
        await transferCall(call_sid, toNumber);
        console.log(`[Twilio] Call transfer initiated to ${toNumber}`);
        logInteraction(`Call transferred to ${toNumber}`);
        transferStatus = 'success';
      } catch (transferErr) {
        console.error(`[Twilio] Transfer failed, but email was sent: ${transferErr.message}`);
        logInteraction(`[ERROR] Transfer failed (email was sent): ${transferErr.message}`);
        transferStatus = 'failed';
        transferError = transferErr.message;
      }
    } else if (!toNumber) {
      transferStatus = 'failed';
      transferError = 'No phone number found for this staff member';
    }

    // Send call summary notification to Rod
    const timestamp = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
    const statusLabel = transferStatus === 'success'
      ? 'TRANSFERRED SUCCESSFULLY'
      : transferStatus === 'failed'
        ? 'TRANSFER FAILED'
        : 'NO TRANSFER ATTEMPTED';
    const summarySubject = `ABACUS Call Summary — ${Caller_Name} → ${Callee_Name} [${statusLabel}]`;
    const summaryBody = `
Call Summary — ${timestamp}
${'='.repeat(50)}

Caller:       ${Caller_Name}
Caller Phone: ${Caller_Phone || caller_id || 'Unknown'}

Requested:    ${Callee_Name}
Callee Phone: ${toNumber || 'Not in directory'}
Callee Email: ${toEmail}
Callee Role:  ${calleeRole}

Message:      ${Caller_Message || 'None'}

Transfer:     ${statusLabel}${transferError ? `\nError:        ${transferError}` : ''}

Call SID:     ${call_sid || 'N/A'}
`.trim();

    try {
      await sendEmail({ to: notifyEmail, subject: summarySubject, body: summaryBody });
      console.log(`[Email] Call summary sent to ${notifyEmail}`);
    } catch (notifyErr) {
      console.error(`[Email] Failed to send call summary to ${notifyEmail}:`, notifyErr.message);
    }

    res.status(200).json({
      status: 'ok',
      email_sent: true,
      transfer_status: transferStatus,
      transfer_error: transferError,
      message: transferStatus === 'success'
        ? 'Email sent and call transfer initiated successfully.'
        : transferStatus === 'failed'
          ? `Email sent but call transfer failed: ${transferError}. Please ask the caller if they would like to leave a message.`
          : 'Email sent. No transfer was attempted.'
    });
  } catch (err) {
    console.error('[Error] Failed to process /send-email:', err.message);
    logInteraction(`[ERROR] ${err.message}`);
    res.status(500).send('Failed to send email');
  }
});

// Endpoint: /transfer — validates phone number against staff directory
app.post('/transfer', (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).send('Missing "to" parameter');

  if (!validPhoneNumbers.has(to)) {
    console.warn(`[Transfer] Rejected transfer to unknown number: ${to}`);
    logInteraction(`[REJECTED] Transfer attempt to unknown number: ${to}`);
    return res.status(403).send('Transfer number not in staff directory');
  }

  const xml = `<Response><Dial>${to}</Dial></Response>`;
  console.log('[Transfer] Returning TwiML:', xml);
  logInteraction(`Transfer XML generated for ${to}`);
  res.set('Content-Type', 'text/xml').send(xml);
});

// Endpoint: /call-ended — Twilio StatusCallback, fetches transcript and emails it
app.post('/call-ended', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  // Respond immediately so Twilio doesn't retry
  res.status(200).send('OK');

  if (!callSid || callStatus !== 'completed') return;

  console.log(`[Call Ended] Call ${callSid} completed`);

  const callData = activeCallStore.get(callSid);
  activeCallStore.delete(callSid);

  if (!ELEVENLABS_API_KEY) {
    console.warn('[Call Ended] ELEVENLABS_API_KEY not set, skipping transcript');
    return;
  }

  // Wait for ElevenLabs to finish processing the conversation
  await new Promise(resolve => setTimeout(resolve, 15000));

  try {
    // List recent conversations for this agent and find the matching one
    const listResp = await axios.get(
      `https://api.elevenlabs.io/v1/convai/conversations`,
      {
        params: { agent_id: ELEVENLABS_AGENT_ID, page_size: 10 },
        headers: { 'xi-api-key': ELEVENLABS_API_KEY }
      }
    );

    const conversations = (listResp.data.conversations || []);
    if (conversations.length === 0) {
      console.warn('[Call Ended] No conversations found for agent');
      return;
    }

    // Use the most recent completed conversation
    const conv = conversations.find(c => c.status === 'done') || conversations[0];
    const conversationId = conv.conversation_id;

    // Fetch full conversation with transcript
    const convResp = await axios.get(
      `https://api.elevenlabs.io/v1/convai/conversations/${conversationId}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    );

    const conversation = convResp.data;
    const transcript = conversation.transcript || [];

    if (transcript.length === 0) {
      console.warn('[Call Ended] Transcript is empty for conversation', conversationId);
      return;
    }

    // Format transcript, filtering out null/empty tool-call entries
    const formattedTranscript = transcript
      .filter(turn => turn.message && turn.message !== 'null')
      .map(turn => {
        const speaker = turn.role === 'agent' ? 'Lauren' : 'Caller';
        const timeStr = turn.time_in_call_secs != null ? `[${formatTime(turn.time_in_call_secs)}]` : '';
        return `${timeStr} ${speaker}: ${turn.message}`;
      }).join('\n\n');

    // Build email
    const timestamp = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
    const callerInfo = callData
      ? `${callData.caller_name} (${callData.caller_phone})`
      : req.body.From || `Unknown (Call SID: ${callSid})`;
    const calleeInfo = callData?.callee_name || 'Unknown';
    const duration = conv.call_duration_secs
      ? formatTime(conv.call_duration_secs)
      : req.body.CallDuration ? formatTime(parseInt(req.body.CallDuration)) : 'Unknown';
    const analysis = conversation.analysis || {};

    const subject = `ABACUS Call Transcript - ${callerInfo}`;
    const body = `
Call Transcript - ${timestamp}
${'='.repeat(50)}

Caller:    ${callerInfo}
Requested: ${calleeInfo}
Duration:  ${duration}
Call SID:  ${callSid}
${analysis.call_successful != null ? `Successful: ${analysis.call_successful}` : ''}
${analysis.transcript_summary ? `Summary: ${analysis.transcript_summary}` : ''}

${'='.repeat(50)}
TRANSCRIPT
${'='.repeat(50)}

${formattedTranscript}

${'='.repeat(50)}
End of transcript
`.trim();

    await sendEmail({ to: notifyEmail, subject, body });
    console.log(`[Call Ended] Transcript emailed to ${notifyEmail}`);
    logInteraction(`Transcript for call ${callSid} emailed to ${notifyEmail}`);
  } catch (err) {
    console.error('[Call Ended] Failed to fetch/send transcript:', err.message);
    logInteraction(`[ERROR] Transcript fetch/send failed for ${callSid}: ${err.message}`);
  }
});

// Reload callee directory (POST /reload-directory)
app.post('/reload-directory', (req, res) => {
  try {
    calleeDirectory = loadCalleeDirectory();
    validPhoneNumbers = getValidPhoneNumbers();
    console.log(`[Reload] Reloaded ${Object.keys(calleeDirectory).length} callee entries`);
    logInteraction(`Directory reloaded: ${Object.keys(calleeDirectory).length} entries`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[Reload] Failed:', err.message);
    res.status(500).send('Failed to reload directory');
  }
});

// Health check / keep-alive endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    callees: Object.keys(calleeDirectory).length,
    uptime: process.uptime()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).send('HDG Reception - Running');
});

// Start server
app.listen(PORT, () => {
  console.log(`[Startup] Listening on port ${PORT}`);
  logInteraction(`Server started on port ${PORT}`);
});
