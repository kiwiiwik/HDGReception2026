// index.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const calleeListPath = path.join(__dirname, 'callee_list.txt');
const fallbackEmail = process.env.FALLBACK_EMAIL || 'rod.grant@i6.co.nz';

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

    if (call_sid && toNumber) {
      try {
        await transferCall(call_sid, toNumber);
        console.log(`[Twilio] Call transfer initiated to ${toNumber}`);
        logInteraction(`Call transferred to ${toNumber}`);
      } catch (transferErr) {
        console.error(`[Twilio] Transfer failed, but email was sent: ${transferErr.message}`);
        logInteraction(`[ERROR] Transfer failed (email was sent): ${transferErr.message}`);
      }
    }

    res.status(200).send('OK');
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
