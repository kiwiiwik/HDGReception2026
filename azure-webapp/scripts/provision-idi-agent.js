// provision-idi-agent.js — (re)provisions the IDI business's ElevenLabs tools and
// points the existing agent at them.
//
//   node scripts/provision-idi-agent.js            # dry run — prints payloads, changes nothing
//   node scripts/provision-idi-agent.js --create   # create tools + PATCH the agent
//
// The agent itself already exists; this creates the *_IDI tools (the originals were
// named *_ROD and pointed at /…/rod) and repoints the agent at them.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const axios = require('axios');

const API = 'https://api.elevenlabs.io/v1';
const KEY = process.env.ELEVENLABS_API_KEY;
const CREATE = process.argv.includes('--create');

const BASE_URL = 'https://receptionisthdg.azurewebsites.net';
const BUSINESS = 'idi';
const AGENT_ID = 'agent_9401ky30y52eevxbt9n08k7d1vgv';
// Superseded *_ROD tools, deleted after the agent no longer references them
const OLD_TOOL_IDS = [
  'tool_1601ky30y4ane9aapvbm0vsrtnej',
  'tool_9301ky30y4k5fdfsw2djbeysh3zs',
  'tool_8201ky30y4txejj97f94b12ex00v'
];

if (!KEY) { console.error('ELEVENLABS_API_KEY missing from azure-webapp/.env'); process.exit(1); }
const h = { headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' } };

// The API allows exactly ONE of description / dynamic_variable / constant_value /
// is_system_provided / is_omitted per property — combining them is a 422.
const sysVar = (name) => ({
  type: 'string', description: '', enum: null, is_system_provided: false,
  dynamic_variable: name, allowed_values_dynamic_variable: '', constant_value: '', is_omitted: false
});
const llmField = (desc) => ({
  type: 'string', description: desc, enum: null, is_system_provided: false,
  dynamic_variable: '', allowed_values_dynamic_variable: '', constant_value: '', is_omitted: false
});
const constField = (value) => ({
  type: 'string', description: '', enum: null, is_system_provided: false,
  dynamic_variable: '', allowed_values_dynamic_variable: '', constant_value: value, is_omitted: false
});

function webhookTool({ name, description, url, properties, required, forcePreToolSpeech = false }) {
  return {
    tool_config: {
      type: 'webhook', name, description,
      response_timeout_secs: 20, disable_interruptions: false, interruption_mode: 'allow',
      // Finish the spoken line before the tool fires. Load-bearing for the transfer:
      // it redirects the live call off the media stream, cutting any audio mid-word.
      force_pre_tool_speech: forcePreToolSpeech,
      pre_tool_speech: 'auto', assignments: [], tool_call_sound: null,
      tool_call_sound_behavior: 'auto', tool_error_handling_mode: 'auto',
      dynamic_variables: { dynamic_variable_placeholders: {} },
      execution_mode: 'immediate',
      api_schema: {
        request_headers: {}, url, method: 'POST',
        path_params_schema: {}, query_params_schema: null,
        request_body_schema: {
          description, dynamic_variable: '', is_omitted: false,
          type: 'object', required, properties
        },
        response_body_schema: null, response_filter: null,
        content_type: 'application/json', auth_resolved_params: [], auth_connection: null
      }
    }
  };
}

const TOOLS = [
  webhookTool({
    name: 'TransferCall_IDI',
    description: 'Rings Rod on his mobile. Call this immediately at the start of the call — do not ask the caller for their name first. If he does not answer, the call automatically returns to you and you will be told so; do not call this tool a second time in that case.',
    url: `${BASE_URL}/transfer-call/${BUSINESS}`,
    forcePreToolSpeech: true,
    // Caller_Name deliberately NOT required — this business transfers immediately,
    // before anyone has been asked their name.
    required: ['Callee_Name', 'Caller_Phone', 'caller_id', 'call_sid'],
    properties: {
      Callee_Name: constField('Rod'),
      Caller_Name: llmField("The caller's name, ONLY if they have already volunteered it. Leave empty otherwise — never invent one and never ask for one just to fill this field."),
      Caller_Phone: sysVar('system__caller_id'),
      caller_id: sysVar('system__caller_id'),
      call_sid: sysVar('system__call_sid')
    }
  }),
  webhookTool({
    name: 'SendMessage_IDI',
    description: "Emails Rod a message on the caller's behalf. Use after a transfer rings out, outside business hours, or whenever the caller asks to leave a message.",
    url: `${BASE_URL}/send-message/${BUSINESS}`,
    required: ['Callee_Name', 'Caller_Name', 'Caller_Message', 'Caller_Phone', 'caller_id', 'call_sid'],
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
    name: 'SendText_IDI',
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

const bizDir = path.join(__dirname, '..', 'businesses', BUSINESS);
const config = JSON.parse(fs.readFileSync(path.join(bizDir, 'config.json'), 'utf-8'));
// Dashboard values are fallbacks only — index.js overrides both per call. Kept in
// sync so a failed override degrades to the right persona rather than the wrong one.
const fallbackPrompt = fs.readFileSync(path.join(bizDir, 'prompt-hours-unknown.md'), 'utf-8');

const sysTool = (t) => ({
  type: 'system', name: t, description: '', response_timeout_secs: 20,
  disable_interruptions: false, interruption_mode: 'allow', force_pre_tool_speech: false,
  pre_tool_speech: 'auto', assignments: [], tool_call_sound: null,
  tool_call_sound_behavior: 'auto', tool_error_handling_mode: 'auto',
  params: { system_tool_type: t }
});

const agentPatch = (toolIds) => ({
  name: `${config.receptionistName} — ${config.displayName}`,
  conversation_config: {
    agent: {
      first_message: config.greeting,
      prompt: {
        prompt: fallbackPrompt,
        tool_ids: toolIds,
        built_in_tools: { end_call: sysTool('end_call') }
      }
    }
  }
});

(async () => {
  if (!CREATE) {
    console.log('=== DRY RUN — nothing will be changed. Re-run with --create to apply. ===\n');
    for (const t of TOOLS) {
      const c = t.tool_config;
      const req = c.api_schema.request_body_schema.required;
      console.log(`  ${c.name}  →  POST ${c.api_schema.url}`);
      for (const [k, v] of Object.entries(c.api_schema.request_body_schema.properties)) {
        const src = v.constant_value ? `constant "${v.constant_value}"`
          : v.dynamic_variable ? `{{${v.dynamic_variable}}}` : 'LLM-filled';
        console.log(`      ${k.padEnd(15)} ${src}${req.includes(k) ? '' : '   (OPTIONAL)'}`);
      }
      console.log('');
    }
    console.log(`  AGENT ${AGENT_ID} → name "${agentPatch([]).name}"`);
    console.log(`  first_message: ${JSON.stringify(config.greeting).slice(0, 120)}`);
    console.log(`  fallback prompt: ${fallbackPrompt.length} chars from businesses/${BUSINESS}/prompt-hours-unknown.md`);
    console.log(`  will delete superseded tools: ${OLD_TOOL_IDS.join(', ')}`);
    return;
  }

  const toolIds = [];
  for (const t of TOOLS) {
    const r = await axios.post(`${API}/convai/tools`, t, h);
    const id = r.data.id || r.data.tool_id;
    console.log(`Created ${t.tool_config.name} → ${id}`);
    toolIds.push(id);
  }

  await axios.patch(`${API}/convai/agents/${AGENT_ID}`, agentPatch(toolIds), h);
  console.log(`Patched agent ${AGENT_ID}`);

  // Only safe once the agent no longer references them
  for (const id of OLD_TOOL_IDS) {
    try { await axios.delete(`${API}/convai/tools/${id}`, h); console.log(`Deleted old tool ${id}`); }
    catch (e) { console.log(`Could not delete ${id}: ${e.response?.status}`); }
  }

  const v = (await axios.get(`${API}/convai/agents/${AGENT_ID}`, h)).data;
  const p = v.conversation_config?.agent?.prompt || {};
  const o = v.platform_settings?.overrides?.conversation_config_override || {};
  console.log('\n--- VERIFY ---');
  console.log(' name:         ', v.name);
  console.log(' webhook tools:', (p.tools || []).filter(t => t.type === 'webhook').map(t => t.name).join(', '));
  console.log(' system tools: ', Object.entries(p.built_in_tools || {}).filter(([, x]) => x).map(([n]) => n).join(', ') || 'NONE');
  console.log(' voice:        ', v.conversation_config?.tts?.voice_id);
  console.log(' overrides ok: ', o.agent?.first_message === true && o.agent?.prompt?.prompt === true && o.agent?.prompt?.llm === true ? 'YES' : 'NO <<<');
})().catch(e => {
  console.error('FAILED:', e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 600) || e.message);
  process.exit(1);
});
