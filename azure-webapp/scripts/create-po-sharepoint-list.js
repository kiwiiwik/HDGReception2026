// create-po-sharepoint-list.js — creates the "Purchase Orders" register list that
// purchase-orders.js mirrors each request into.
//
//   node scripts/create-po-sharepoint-list.js <host>:/sites/<SiteName> ["List Name"]
//   e.g. node scripts/create-po-sharepoint-list.js hdgnz.sharepoint.com:/sites/StaffHub
//
// Needs GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET in azure-webapp/.env, for
// an app registration with Sites.Selected (write) on that site. Then set
// purchaseOrders.sharePoint = { "site": "<same arg>", "list": "<List Name>" } in config.json.
// Column internal names must match the fields in syncToSharePoint().

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');

const [site, listName = 'Purchase Orders'] = process.argv.slice(2);
if (!site) { console.error('Usage: node scripts/create-po-sharepoint-list.js <host>:/sites/<SiteName> ["List Name"]'); process.exit(1); }

const text = (name, extra = {}) => ({ name, text: extra });
const COLUMNS = [
  text('PONumber'), text('Status'), text('Requester'), text('RequesterPhone'),
  text('Job'), text('JobDescription'), text('Supplier'),
  text('Details', { allowMultipleLines: true }),
  { name: 'Amount', currency: { locale: 'en-nz' } },
  { name: 'Retrospective', boolean: {} },
  text('PurchaseDate'), text('ApprovalTier'), text('Approver'), text('DecidedBy'),
  text('RejectReason', { allowMultipleLines: true }),
  { name: 'RequestedAt', dateTime: { format: 'dateTime' } },
  { name: 'DecidedAt', dateTime: { format: 'dateTime' } }
];

(async () => {
  const tok = await axios.post(
    `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.GRAPH_CLIENT_ID,
      client_secret: process.env.GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  );
  const h = { headers: { Authorization: `Bearer ${tok.data.access_token}` } };
  const G = 'https://graph.microsoft.com/v1.0';

  const s = (await axios.get(`${G}/sites/${site}`, h)).data;
  console.log(`Site: ${s.displayName} (${s.id})`);
  const list = (await axios.post(`${G}/sites/${s.id}/lists`, {
    displayName: listName, columns: COLUMNS, list: { template: 'genericList' }
  }, h)).data;
  console.log(`Created list "${list.displayName}" → ${list.webUrl}`);
  console.log(`\nNow set in businesses/hdg/config.json:\n  "sharePoint": { "site": "${site}", "list": "${listName}" }`);
})().catch(e => {
  console.error('FAILED:', e.response?.status, e.response?.data?.error?.message || e.message);
  process.exit(1);
});
