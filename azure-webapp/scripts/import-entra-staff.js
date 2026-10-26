// import-entra-staff.js — adds every enabled Entra ID user with a mobile number to a
// business's staff list (callee_list.txt), so callers can be put through to them.
//
//   node scripts/import-entra-staff.js --env "C:/Code/HDG SharePoint/.env"           # dry run
//   node scripts/import-entra-staff.js --env "C:/Code/HDG SharePoint/.env" --write   # apply
//   (--business hdg is the default)
//
// Credentials: TENANT_ID / CLIENT_ID / CLIENT_SECRET (or the GRAPH_ prefixed names) from
// --env, else azure-webapp/.env. The app registration needs User.Read.All (application) —
// the HDG SharePoint one doesn't have it (403). Or pass --az to use your own sign-in:
//   az login --tenant <HDG tenant id>
//   node scripts/import-entra-staff.js --env "C:/Code/HDG SharePoint/.env" --az
//
// Merge rules — the staff list is hand-curated, so existing lines win:
//   - matched by email, then by phone; an existing line is never rewritten, except that a
//     blank phone is filled in from Entra
//   - a phone that differs from Entra is reported, not changed
//   - Entra users not already listed are added, role = job title
//   - anyone in businesses/{id}/entra-exclude.txt (one email per line) is never added
// Only mobilePhone is used: businessPhones are often the shared office line, and two
// staff with the same number would be indistinguishable to caller ID.

const path = require('path');
const fs = require('fs');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
require('dotenv').config({ path: arg('--env') || path.join(__dirname, '..', '.env') });
const axios = require('axios');

const WRITE = process.argv.includes('--write');
const BUSINESS = arg('--business') || 'hdg';
const listPath = path.join(__dirname, '..', 'businesses', BUSINESS, 'callee_list.txt');

const TENANT = process.env.GRAPH_TENANT_ID || process.env.TENANT_ID;
const CLIENT = process.env.GRAPH_CLIENT_ID || process.env.CLIENT_ID;
const SECRET = process.env.GRAPH_CLIENT_SECRET || process.env.CLIENT_SECRET;
// --az: use your own Azure CLI sign-in (az login --tenant <hdg tenant>) instead of the
// app registration. Ordinary users can read the directory, so no admin consent is needed.
const USE_AZ = process.argv.includes('--az');
if (!USE_AZ && (!TENANT || !CLIENT || !SECRET)) { console.error('Missing TENANT_ID / CLIENT_ID / CLIENT_SECRET (or use --az)'); process.exit(1); }

async function graphToken() {
  if (USE_AZ) {
    const tenantArg = TENANT ? ` --tenant ${TENANT}` : '';
    return require('child_process').execSync(
      `az account get-access-token --resource https://graph.microsoft.com${tenantArg} --query accessToken -o tsv`,
      { encoding: 'utf-8' }).trim();
  }
  const tok = await axios.post(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, new URLSearchParams({
    client_id: CLIENT, client_secret: SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
  }));
  return tok.data.access_token;
}

// "021 522 500", "+64 21 522 500", "+64 (0)21 522500" → "+6421522500". Non-NZ numbers kept as +digits.
function toE164(raw) {
  let s = String(raw || '').replace(/\(0\)/g, '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return `+${s.slice(2)}`;
  if (s.startsWith('64')) return `+${s}`;
  if (s.startsWith('0')) return `+64${s.slice(1)}`;
  return `+64${s}`;
}
const digits = p => String(p || '').replace(/\D/g, '');
const csvSafe = s => String(s || '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim(); // the list is naive CSV

(async () => {
  const h = { headers: { Authorization: `Bearer ${await graphToken()}` } };

  let url = 'https://graph.microsoft.com/v1.0/users?$select=displayName,mail,userPrincipalName,mobilePhone,jobTitle,accountEnabled,userType&$top=999';
  const users = [];
  while (url) {
    const r = (await axios.get(url, h)).data;
    users.push(...r.value);
    url = r['@odata.nextLink'];
  }
  // entra-exclude.txt: people deliberately kept off the list, so a re-run doesn't re-add them
  const excludePath = path.join(path.dirname(listPath), 'entra-exclude.txt');
  const excluded = new Set(fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, 'utf-8').split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#'))
    : []);
  const isExcluded = u => [u.mail, u.userPrincipalName].some(e => e && excluded.has(e.toLowerCase()));
  const withMobile = users.filter(u => u.accountEnabled && u.userType !== 'Guest' && u.mobilePhone && !isExcluded(u));
  console.log(`Entra: ${users.length} users, ${withMobile.length} enabled members with a mobile number (${excluded.size} excluded by entra-exclude.txt)\n`);

  const lines = fs.readFileSync(listPath, 'utf-8').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const [header, ...rows] = lines;
  const entries = rows.map(l => { const [name, email, phone, ...role] = l.split(','); return { name, email, phone, role: role.join(','), line: l }; });

  const added = [], filled = [], conflicts = [], same = [];
  for (const u of withMobile) {
    const email = u.mail || u.userPrincipalName;
    const phone = toE164(u.mobilePhone);
    const existing = entries.find(e => e.email && e.email.toLowerCase() === email.toLowerCase())
      || entries.find(e => e.phone && digits(e.phone) === digits(phone));
    const sameName = entries.find(e => e.name.toLowerCase() === csvSafe(u.displayName).toLowerCase());
    if (!existing && sameName) {
      // Same person under another address (Susan Liu's gibcon.onmicrosoft.com account).
      // Adding would create a second entry with the same name, and the staff directory
      // keeps the last one — silently replacing the curated line.
      conflicts.push(`${u.displayName}: already listed as ${sameName.email} — Entra has ${email}, ${phone}; not added`);
    } else if (!existing) {
      const e = { name: csvSafe(u.displayName), email, phone, role: csvSafe(u.jobTitle) };
      e.line = [e.name, e.email, e.phone, e.role].join(',');
      entries.push(e); added.push(e);
    } else if (!existing.phone) {
      existing.phone = phone;
      existing.line = [existing.name, existing.email, phone, existing.role].join(',');
      filled.push(existing);
    } else if (digits(existing.phone) !== digits(phone)) {
      conflicts.push(`${existing.name}: list has ${existing.phone}, Entra has ${phone} (${u.displayName}) — kept the list's`);
    } else same.push(existing.name);
  }

  // Two people on one number can't be told apart by caller ID — report, don't guess
  const byPhone = {};
  for (const e of entries) if (e.phone) (byPhone[digits(e.phone)] ||= []).push(e.name);
  const shared = Object.entries(byPhone).filter(([, n]) => n.length > 1);

  console.log(`Already listed, matching: ${same.length}`);
  console.log(`\nTo add (${added.length}):`); added.forEach(e => console.log(`  + ${e.line}`));
  console.log(`\nPhone filled in (${filled.length}):`); filled.forEach(e => console.log(`  ~ ${e.line}`));
  console.log(`\nConflicts, left as is (${conflicts.length}):`); conflicts.forEach(c => console.log(`  ! ${c}`));
  if (shared.length) { console.log(`\nWARNING — numbers shared by more than one entry:`); shared.forEach(([p, n]) => console.log(`  ${p}: ${n.join(', ')}`)); }

  if (!WRITE) { console.log('\nDry run — nothing written. Re-run with --write to apply.'); return; }
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name)).map(e => e.line);
  fs.writeFileSync(listPath, [header, ...sorted].join('\n') + '\n', 'utf-8');
  console.log(`\nWrote ${sorted.length} entries to businesses/${BUSINESS}/callee_list.txt`);
})().catch(e => {
  console.error('FAILED:', e.response?.status, e.response?.data?.error?.message || e.message);
  process.exit(1);
});
