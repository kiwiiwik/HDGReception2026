// provision-rod-agent.js — creates the ROD business's ElevenLabs agent + its 3 webhook tools.
//
//   node scripts/provision-rod-agent.js            # dry run — prints payloads, creates nothing
//   node scripts/provision-rod-agent.js --create   # actually creates them
//
// On success it prints the agent_id to paste into businesses/rod/config.json.
// Modelled on the DEMO agent (Alex) so ROD matches the working setup, with three
// deliberate differences, each commented at the point it matters.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const axios = require('axios');

const API = 'https://api.elevenlabs.io/v1';
const KEY = process.env.ELEVENLABS_API_KEY;
const CREATE = process.argv.includes('--create');

const BASE_URL = 'https://receptionisthdg.azurewebsites.net';
const BUSINESS = 'rod';
const VOICE_ID = 'Xb7hH8MSUJpSbSDYk0k2';   // Alice — British female
const LLM = 'gemini-2.5-flash';            // matches Alex/Lauren
const TTS_MODEL = 'eleven_turbo_v2';

if (!KEY) { console.error('ELEVENLABS_API_KEY missing from azure-webapp/.env'); process.exit(1); }

const h = { headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' } };

// Bind a body param to an ElevenLabs system variable rather than letting the LLM
// fill it. call_sid especially — a hallucinated SID means the Twilio redirect 404s
// and the transfer silently never happens.
// NOTE: the API allows exactly ONE of description / dynamic_variable /
// constant_value / is_system_provided / is_omitted per property — setting a
// description alongside a binding is a 422. Hence the empty descriptions below.
const sysVar = (name) => ({
  type: 'string', description: '', enum: null,
  is_system_provided: false, dynamic_variable: name,
  allowed_values_dynamic_variable: '', constant_value: '', is_omitted: false
});
const llmField = (desc) => ({
  type: 'string', description: desc, enum: null,
  is_system_provided: false, dynamic_variable: '',
  allowed_values_dynamic_variable: '', constant_value: '', is_omitted: false
});
// ROD has exactly one staff member, so pin Callee_Name instead of letting the LLM
// type it. Removes the "callee not found → fallback email" failure mode entirely.
const constField = (value) => ({
  type: 'string', description: '', enum: null,
  is_system_provided: false, dynamic_variable: '',
  allowed_values_dynamic_variable: '', constant_value: value, is_omitted: false
});

function webhookTool({ name, description, url, properties, required, forcePreToolSpeech = false }) {
  return {
    tool_config: {
      type: 'webhook',
      name,
      description,
      response_timeout_secs: 20,
      disable_interruptions: false,
      interruption_mode: 'allow',
      // Make the agent finish its spoken line BEFORE the tool fires. For
      // TransferCall_ROD this is load-bearing: the tool redirects the live call off
      // the media stream, so anything still being spoken gets cut mid-word.
      force_pre_tool_speech: forcePreToolSpeech,
      pre_tool_speech: 'auto',
      assignments: [],
      tool_call_sound: null,
      tool_call_sound_behavior: 'auto',
      tool_error_handling_mode: 'auto',
      dynamic_variables: { dynamic_variable_placeholders: {} },
      execution_mode: 'immediate',
      api_schema: {
        request_headers: {},
        url,
        method: 'POST',
        path_params_schema: {},
        query_params_schema: null,
        request_body_schema: {
          description, dynamic_variable: '', is_omitted: false,
          type: 'object', required, properties
        },
        response_body_schema: null,
        response_filter: null,
        content_type: 'application/json',
        auth_resolved_params: [],
        auth_connection: null
      }
    }
  };
}

const TOOLS = [
  webhookTool({
    name: 'TransferCall_ROD',
    description: 'Rings Rod on his mobile for about 25 seconds. If he does not answer, the call automatically returns to you and you will be told so — do not call this tool a second time in that case. Do not use this tool outside business hours.',
    url: `${BASE_URL}/transfer-call/${BUSINESS}`,
    forcePreToolSpeech: true,
    required: ['Callee_Name', 'Caller_Name', 'Caller_Phone', 'caller_id', 'call_sid'],
    properties: {
      Callee_Name: constField('Rod'),
      Caller_Name: llmField("The caller's name"),
      Caller_Phone: sysVar('system__caller_id'),
      caller_id: sysVar('system__caller_id'),
      call_sid: sysVar('system__call_sid')
    }
  }),
  webhookTool({
    name: 'SendMessage_ROD',
    description: "Emails Rod a message on the caller's behalf. Use after a transfer rings out, outside business hours, or whenever the caller asks to leave a message.",
    url: `${BASE_URL}/send-message/${BUSINESS}`,
    required: ['Callee_Name', 'Caller_Name', 'Caller_Phone', 'Caller_Message', 'caller_id', 'call_sid'],
    properties: {
      Callee_Name: constField('Rod'),
      Caller_Name: llmField("The caller's name"),
      Caller_Phone: sysVar('system__caller_id'),
      Caller_Message: llmField("The caller's message, in their own words where possible. Note if they said it was urgent."),
      caller_id: sysVar('system__caller_id'),
      call_sid: sysVar('system__call_sid')
    }
  }),
  webhookTool({
    name: 'SendText_ROD',
    description: 'Sends an SMS to the caller. Only use when the caller explicitly asks to be texted something. Never send unsolicited texts.',
    url: `${BASE_URL}/send-text/${BUSINESS}`,
    required: ['to_phone', 'message', 'caller_id'],
    properties: {
      to_phone: sysVar('system__caller_id'),
      message: llmField('The text message content to send'),
      caller_id: sysVar('system__caller_id')
    }
  })
];

// Dashboard prompt is a fallback only — index.js always overrides it per call.
// Seed it with the business-hours-unknown prompt so a failed override degrades sanely.
const fallbackPrompt = fs.readFileSync(
  path.join(__dirname, '..', 'businesses', BUSINESS, 'prompt-hours-unknown.md'), 'utf-8'
);

function agentPayload(toolIds) {
  return {
    name: "Ava — Rod Grant's Receptionist",
    conversation_config: {
      agent: {
        first_message: 'Hi there, how can I help?',   // overridden per call by the bridge
        language: 'en',
        prompt: { prompt: fallbackPrompt, llm: LLM, temperature: 0, tool_ids: toolIds }
      },
      // pcm_16000 both directions — the bridge converts to/from Twilio's mulaw 8k
      tts: { voice_id: VOICE_ID, model_id: TTS_MODEL, agent_output_audio_format: 'pcm_16000' },
      asr: { user_input_audio_format: 'pcm_16000' }
    },
    platform_settings: {
      // The three overrides the bridge depends on. Without first_message and
      // prompt.prompt, the ring-reclaim leg falls back to this dashboard prompt and
      // Ava re-greets a caller who has just heard the phone ring out.
      overrides: {
        conversation_config_override: {
          agent: {
            first_message: true,
            prompt: { prompt: true, llm: true }
          }
        }
      }
    }
  };
}

(async () => {
  if (!CREATE) {
    console.log('=== DRY RUN — nothing will be created. Re-run with --create to apply. ===\n');
    console.log('--- 3 WEBHOOK TOOLS ---');
    for (const t of TOOLS) {
      const c = t.tool_config;
      console.log(`\n  ${c.name}  →  POST ${c.api_schema.url}`);
      console.log(`    force_pre_tool_speech: ${c.force_pre_tool_speech}`);
      for (const [k, v] of Object.entries(c.api_schema.request_body_schema.properties)) {
        const src = v.constant_value ? `constant "${v.constant_value}"`
          : v.dynamic_variable ? `{{${v.dynamic_variable}}}` : 'LLM-filled';
        console.log(`    ${k.padEnd(15)} ${src}`);
      }
    }
    const a = agentPayload(['<tool_id_1>', '<tool_id_2>', '<tool_id_3>']);
    console.log('\n--- AGENT ---');
    console.log(`  name:      ${a.name}`);
    console.log(`  voice_id:  ${VOICE_ID} (Alice — British female)`);
    console.log(`  llm:       ${LLM}  temperature: 0`);
    console.log(`  audio:     in ${a.conversation_config.asr.user_input_audio_format} / out ${a.conversation_config.tts.agent_output_audio_format}`);
    console.log(`  overrides: ${JSON.stringify(a.platform_settings.overrides.conversation_config_override)}`);
    console.log(`  fallback prompt: ${fallbackPrompt.length} chars from businesses/${BUSINESS}/prompt-hours-unknown.md`);
    return;
  }

  const toolIds = [];
  for (const t of TOOLS) {
    const r = await axios.post(`${API}/convai/tools`, t, h);
    const id = r.data.id || r.data.tool_id;
    console.log(`Created tool ${t.tool_config.name} → ${id}`);
    toolIds.push(id);
  }

  const r = await axios.post(`${API}/convai/agents/create`, agentPayload(toolIds), h);
  const agentId = r.data.agent_id;
  console.log(`\nCreated agent → ${agentId}`);
  console.log(`\nNext: set "elevenLabsAgentId": "${agentId}" in businesses/${BUSINESS}/config.json`);
})().catch(e => {
  console.error('FAILED:', e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 600) || e.message);
  process.exit(1);
});
