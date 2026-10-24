// add-po-tool-hdg.js — gives Lauren (HDG agent) the SubmitPurchaseOrder tool.
//
//   node scripts/add-po-tool-hdg.js            # dry run — shows current tools and the new one
//   node scripts/add-po-tool-hdg.js --create   # create the tool and attach it to the agent
//   node scripts/add-po-tool-hdg.js --update   # rewrite the attached tool from TOOL below
//
// Only tool_ids is patched; the agent's voice, LLM, prompt and existing tools are left as
// they are. Run once — it refuses if the agent already has the tool.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');

const API = 'https://api.elevenlabs.io/v1';
const KEY = process.env.ELEVENLABS_API_KEY;
const CREATE = process.argv.includes('--create');
const UPDATE = process.argv.includes('--update'); // rewrite the already-attached tool's definition

const BASE_URL = 'https://receptionisthdg.azurewebsites.net';
const BUSINESS = 'hdg';
const AGENT_ID = 'agent_01jysz8r0bejrvx2d9wv8gckca';
const TOOL_NAME = 'SubmitPurchaseOrder';

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

const TOOL = {
  tool_config: {
    type: 'webhook',
    name: TOOL_NAME,
    description: 'Submits a purchase order request once the caller has confirmed what they need, the cost, the supplier and the job. Returns approved (with a PO number), pending_approval, or a problem to sort out with the caller. Call once per purchase.',
    response_timeout_secs: 20, disable_interruptions: false, interruption_mode: 'allow',
    force_pre_tool_speech: false, pre_tool_speech: 'auto', assignments: [], tool_call_sound: null,
    tool_call_sound_behavior: 'auto', tool_error_handling_mode: 'auto',
    dynamic_variables: { dynamic_variable_placeholders: {} },
    execution_mode: 'immediate',
    api_schema: {
      request_headers: {}, url: `${BASE_URL}/purchase-order/${BUSINESS}`, method: 'POST',
      path_params_schema: {}, query_params_schema: null,
      request_body_schema: {
        description: 'A purchase order request', dynamic_variable: '', is_omitted: false,
        type: 'object',
        required: ['Description', 'Amount', 'Supplier', 'Job_Number', 'Already_Purchased', 'caller_id', 'call_sid'],
        properties: {
          Description: llmField('Every item being bought with its quantity, word for word as the caller confirmed it, e.g. "five 20-kilogram bags of cement, one claw hammer". Never shortened or summarised.'),
          Amount: llmField('Estimated cost in NZ dollars, digits only, e.g. "85"'),
          Supplier: llmField('The supplier, e.g. "Bunnings"'),
          Job_Number: llmField('The job number from the Job List, e.g. "GR2401"'),
          Already_Purchased: llmField('"yes" only if the caller said they have already bought it, otherwise "no"'),
          Purchase_Date: llmField('When it was bought, only if already purchased, e.g. "yesterday". Empty otherwise.'),
          caller_id: sysVar('system__caller_id'),
          call_sid: sysVar('system__call_sid')
        }
      },
      response_body_schema: null, response_filter: null,
      content_type: 'application/json', auth_resolved_params: [], auth_connection: null
    }
  }
};

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
  console.log(`  llm: ${before.llm}   built-ins: ${before.builtIns.join(', ') || 'none'}`);
  if (before.toolNames.includes(TOOL_NAME)) {
    if (!UPDATE) {
      console.log(`\n${TOOL_NAME} is already attached. Use --update to rewrite it from this script's definition.`);
      return;
    }
    // Find the attached tool's id by name, then replace its config in place
    let toolId = null;
    for (const id of before.toolIds) {
      const t = (await axios.get(`${API}/convai/tools/${id}`, h)).data;
      if (t.tool_config?.name === TOOL_NAME) { toolId = id; break; }
    }
    if (!toolId) throw new Error(`${TOOL_NAME} is listed on the agent but no tool_id matched`);
    await axios.patch(`${API}/convai/tools/${toolId}`, TOOL, h);
    const t = (await axios.get(`${API}/convai/tools/${toolId}`, h)).data;
    console.log(`\nUpdated ${TOOL_NAME} (${toolId}). Description field now:`);
    console.log(`  ${t.tool_config.api_schema.request_body_schema.properties.Description.description}`);
    return;
  }

  if (!CREATE) {
    console.log(`\n=== DRY RUN — would create ${TOOL_NAME} → POST ${TOOL.tool_config.api_schema.url}`);
    console.log('    and append it to the agent\'s tool_ids. Re-run with --create to apply. ===');
    return;
  }

  const t = await axios.post(`${API}/convai/tools`, TOOL, h);
  const toolId = t.data.id || t.data.tool_id;
  console.log(`\nCreated ${TOOL_NAME} → ${toolId}`);

  await axios.patch(`${API}/convai/agents/${AGENT_ID}`, {
    conversation_config: { agent: { prompt: { tool_ids: [...before.toolIds, toolId] } } }
  }, h);

  const after = summarise((await axios.get(`${API}/convai/agents/${AGENT_ID}`, h)).data);
  console.log('\n--- VERIFY ---');
  console.log(' tools:    ', after.toolNames.join(', '));
  console.log(' llm:      ', after.llm, after.llm === before.llm ? '' : `<<< CHANGED from ${before.llm}`);
  console.log(' built-ins:', after.builtIns.join(', ') || 'none', after.builtIns.join() === before.builtIns.join() ? '' : '<<< CHANGED');
})().catch(e => {
  console.error('FAILED:', e.response?.status, JSON.stringify(e.response?.data)?.slice(0, 600) || e.message);
  process.exit(1);
});
