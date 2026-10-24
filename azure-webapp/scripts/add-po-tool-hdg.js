// add-po-tool-hdg.js — gives Lauren (HDG agent) the purchase-order tools:
//   SubmitPurchaseOrder, AddLineItem, ChangeLineItem, RemoveLineItem
//
//   node scripts/add-po-tool-hdg.js            # dry run — shows what is attached and what isn't
//   node scripts/add-po-tool-hdg.js --create   # create any missing tools and attach them
//   node scripts/add-po-tool-hdg.js --update   # rewrite already-attached tools from TOOLS below
//
// Only tool_ids is patched; the agent's voice, LLM, prompt and other tools are left as
// they are. Tools are matched to the agent by name.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');

const API = 'https://api.elevenlabs.io/v1';
const KEY = process.env.ELEVENLABS_API_KEY;
const CREATE = process.argv.includes('--create');
const UPDATE = process.argv.includes('--update');

const BASE_URL = 'https://receptionisthdg.azurewebsites.net';
const BUSINESS = 'hdg';
const AGENT_ID = 'agent_01jysz8r0bejrvx2d9wv8gckca';

if (!KEY) { console.error('ELEVENLABS_API_KEY missing from azure-webapp/.env'); process.exit(1); }
const h = { headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' } };

// Same property shapes as provision-idi-agent.js — exactly ONE of description /
// dynamic_variable / constant_value per property, or the API returns 422.
const sysVar = (name) => ({
  type: 'string', description: '', enum: null, is_system_provided: false,
  dynamic_variable: name, allowed_values_dynamic_variable: '', constant_value: '', is_omitted: false
});
const llmField = (desc) => ({
  type: 'string', description: desc, enum: null, is_system_provided: false,
  dynamic_variable: '', allowed_values_dynamic_variable: '', constant_value: '', is_omitted: false
});
const callIds = { caller_id: sysVar('system__caller_id'), call_sid: sysVar('system__call_sid') };

function webhookTool({ name, description, url, required, properties }) {
  return {
    tool_config: {
      type: 'webhook', name, description,
      response_timeout_secs: 20, disable_interruptions: false, interruption_mode: 'allow',
      force_pre_tool_speech: false, pre_tool_speech: 'auto', assignments: [], tool_call_sound: null,
      tool_call_sound_behavior: 'auto', tool_error_handling_mode: 'auto',
      dynamic_variables: { dynamic_variable_placeholders: {} },
      execution_mode: 'immediate',
      api_schema: {
        request_headers: {}, url, method: 'POST',
        path_params_schema: {}, query_params_schema: null,
        request_body_schema: {
          description, dynamic_variable: '', is_omitted: false,
          type: 'object', required: [...required, 'caller_id', 'call_sid'],
          properties: { ...properties, ...callIds }
        },
        response_body_schema: null, response_filter: null,
        content_type: 'application/json', auth_resolved_params: [], auth_connection: null
      }
    }
  };
}

const TOOLS = [
  webhookTool({
    name: 'SubmitPurchaseOrder',
    description: 'Submits a purchase order request once the items are saved and you have the cost, the supplier and the job. The first call returns a check to read to the caller; only a call carrying their yes submits. Returns pending_approval, or a problem to sort out with the caller.',
    url: `${BASE_URL}/purchase-order/${BUSINESS}`,
    required: ['Amount', 'Supplier', 'Job_Number', 'Already_Purchased'],
    properties: {
      Description: llmField('Leave EMPTY when you have saved the items with AddLineItem (the normal way). Only if you could not, every item with its quantity, word for word.'),
      Amount: llmField('Estimated total cost in NZ dollars, digits only, e.g. "85"'),
      Supplier: llmField('The supplier, e.g. "Bunnings"'),
      Job_Number: llmField('The job number from the Job List, e.g. "GR2401"'),
      Already_Purchased: llmField('"yes" only if the caller said they have already bought it, otherwise "no"'),
      Purchase_Date: llmField('When it was bought, only if already purchased, e.g. "yesterday". Empty otherwise.'),
      Caller_Confirmation: llmField('The caller\'s exact words when they confirmed the check you read them, e.g. "yes, send it". Leave EMPTY until the caller has actually said it — never fill it in yourself, and never call the tool again just because they have gone quiet.')
    }
  }),
  webhookTool({
    name: 'AddLineItem',
    description: 'Saves one line of a purchase order (quantity + item) as soon as the caller gives it. Call once per item, then echo the item back and ask for the next.',
    url: `${BASE_URL}/po-line/${BUSINESS}/add`,
    required: ['Quantity', 'Item'],
    properties: {
      Quantity: llmField('How many, exactly as the caller said it, e.g. "5" or "2 tubes". Leave empty if they did not say — the tool will tell you to ask.'),
      Item: llmField('The item, word for word with its sizes and brand, e.g. "CemX 20-kilogram MultiCrete bags". One item only.')
    }
  }),
  webhookTool({
    name: 'ChangeLineItem',
    description: 'Corrects one saved line, e.g. "make that twelve" or "it\'s the 25 mm wire, not 20". Use the line number from the latest tool response.',
    url: `${BASE_URL}/po-line/${BUSINESS}/change`,
    required: ['Line_Number'],
    properties: {
      Line_Number: llmField('The line to change, e.g. "3"'),
      Quantity: llmField('The new quantity, or empty to keep it'),
      Item: llmField('The new item wording, or empty to keep it')
    }
  }),
  webhookTool({
    name: 'RemoveLineItem',
    description: 'Takes one saved line off the order when the caller says to drop it.',
    url: `${BASE_URL}/po-line/${BUSINESS}/remove`,
    required: ['Line_Number'],
    properties: { Line_Number: llmField('The line to remove, e.g. "3"') }
  })
];

const summarise = (agent) => {
  const p = agent.conversation_config?.agent?.prompt || {};
  return {
    toolIds: p.tool_ids || [],
    toolNames: (p.tools || []).map(t => t.name),
    llm: p.llm,
    builtIns: Object.entries(p.built_in_tools || {}).filter(([, x]) => x).map(([n]) => n)
  };
};

(async () => {
  const before = summarise((await axios.get(`${API}/convai/agents/${AGENT_ID}`, h)).data);
  console.log(`Agent ${AGENT_ID}`);
  console.log(`  current tools: ${before.toolNames.join(', ') || '(none)'}  [${before.toolIds.length} ids]`);
  console.log(`  llm: ${before.llm}   built-ins: ${before.builtIns.join(', ') || 'none'}\n`);

  // Attached webhook tools by name → id
  const attached = {};
  for (const id of before.toolIds) {
    const t = (await axios.get(`${API}/convai/tools/${id}`, h)).data;
    if (t.tool_config?.name) attached[t.tool_config.name] = id;
  }

  const newIds = [];
  for (const tool of TOOLS) {
    const { name } = tool.tool_config;
    const url = tool.tool_config.api_schema.url;
    if (attached[name]) {
      if (UPDATE) {
        await axios.patch(`${API}/convai/tools/${attached[name]}`, tool, h);
        console.log(`  updated  ${name} (${attached[name]})`);
      } else {
        console.log(`  attached ${name} (${attached[name]})`);
      }
    } else if (CREATE) {
      const t = await axios.post(`${API}/convai/tools`, tool, h);
      const id = t.data.id || t.data.tool_id;
      newIds.push(id);
      console.log(`  created  ${name} → ${id}  (POST ${url})`);
    } else {
      console.log(`  MISSING  ${name} — would create → POST ${url}`);
    }
  }

  if (newIds.length) {
    await axios.patch(`${API}/convai/agents/${AGENT_ID}`, {
      conversation_config: { agent: { prompt: { tool_ids: [...before.toolIds, ...newIds] } } }
    }, h);
    const after = summarise((await axios.get(`${API}/convai/agents/${AGENT_ID}`, h)).data);
    console.log('\n--- VERIFY ---');
    console.log(' tools:    ', after.toolNames.join(', '));
    console.log(' llm:      ', after.llm, after.llm === before.llm ? '' : `<<< CHANGED from ${before.llm}`);
    console.log(' built-ins:', after.builtIns.join(', ') || 'none', after.builtIns.join() === before.builtIns.join() ? '' : '<<< CHANGED');
  } else if (!CREATE && !UPDATE) {
    console.log('\nDry run. --create adds missing tools; --update rewrites attached ones.');
  }
})().catch(e => {
  console.error('FAILED:', e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 600) || e.message);
  process.exit(1);
});
