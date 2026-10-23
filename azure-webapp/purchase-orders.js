// purchase-orders.js — phone-based purchase order workflow (Gibbons Rail POC)
//
//   Staff ring the receptionist and ask for a PO → agent collects what / cost / supplier / job
//     → POST /purchase-order/:businessId        (ElevenLabs webhook tool)
//         validates requester (caller ID) and job, picks the approval tier by amount
//         ├── self-approve tier → PO number issued straight away, read back on the call
//         └── otherwise → approver emailed a review link
//               → GET  /po/review/:businessId/:requestId?t=…   (confirmation page)
//               → POST /po/decide/:businessId/:requestId       (Approve / Reject)
//   On approval: sequential PO number, SMS to requester (Sinch / MessageMedia),
//   summary email to accounts, register updated (JSON file, mirrored to SharePoint).
//
// Config lives in the business's config.json under "purchaseOrders"; the job list in
// jobs.csv (loaded by index.js as business.jobs).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const PDFDocument = require('pdfkit');

module.exports = function registerPurchaseOrders(app, deps) {
  const { getBusiness, findStaffByPhone, fillFromBridge, sendEmail, sendSms, logInteraction } = deps;

  // ── Register ───────────────────────────────────────────────────────────────
  // One JSON file per business in its persistent data dir (/home/data/{id}/ on Azure).
  // The app runs as a single instance and every read-modify-write below is
  // synchronous, so numbering can't race. It is the source of truth; SharePoint is
  // a mirror for accounts to view, filter and export.

  function registerPath(business) {
    return path.join(business.dataDir, 'po-register.json');
  }

  function loadRegister(business) {
    try {
      return JSON.parse(fs.readFileSync(registerPath(business), 'utf-8'));
    } catch (e) {
      return { nextRequest: 1, nextPo: business.config.purchaseOrders.firstPoNumber || 1001, requests: [] };
    }
  }

  function saveRegister(business, register) {
    const file = registerPath(business);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(register, null, 2), 'utf-8');
    fs.renameSync(tmp, file); // never leave a half-written register behind
  }

  // Apply a change to one request inside a single load/save
  function updateRequest(business, requestId, change) {
    const register = loadRegister(business);
    const rec = register.requests.find(r => r.id === requestId);
    if (!rec) return null;
    change(rec, register);
    saveRegister(business, register);
    return rec;
  }

  // ── Approval links ─────────────────────────────────────────────────────────
  // The link is a bearer token: whoever holds the email can decide. Fine for the POC;
  // swap for Entra sign-in if approvals ever need to be attributable to a person.
  function linkSecret(business) {
    if (process.env.PO_LINK_SECRET) return process.env.PO_LINK_SECRET;
    const file = path.join(business.dataDir, 'po-link-secret');
    try { return fs.readFileSync(file, 'utf-8').trim(); }
    catch (e) {
      const secret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(file, secret, 'utf-8');
      return secret;
    }
  }

  function linkToken(business, requestId) {
    return crypto.createHmac('sha256', linkSecret(business))
      .update(`${business.config.id}:${requestId}`).digest('base64url');
  }

  function tokenValid(business, requestId, token) {
    const expected = Buffer.from(linkToken(business, requestId));
    const given = Buffer.from(String(token || ''));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const money = n => `$${Number(n).toFixed(2)}`;
  const nzTime = d => new Date(d).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' });
  const isYes = v => /^(y|yes|true|1)$/i.test(String(v || '').trim());
  const escHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // The LLM fills unknown fields with "None", "null", "N/A" etc. rather than leaving them empty
  function blankIfPlaceholder(value) {
    const s = String(value == null ? '' : value).trim();
    return /^(none|null|undefined|n\/?a|unknown|not specified|tbc|-)?$/i.test(s) ? '' : s;
  }

  // "$1,250.50", "about 85 bucks", "85" → number. Speech-to-text gives us all sorts.
  function parseAmount(value) {
    const m = String(value || '').replace(/,/g, '').match(/\d+(\.\d+)?/);
    return m ? Number(m[0]) : NaN;
  }

  // Job numbers are spoken, so compare ignoring spaces, dashes and case
  const jobKey = s => String(s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  function findJob(business, jobNumber) {
    const key = jobKey(jobNumber);
    return key ? business.jobs.find(j => jobKey(j.job) === key) || null : null;
  }

  // Tiers are ordered; the first whose "under" exceeds the amount wins. The last
  // tier has no "under" and catches everything above.
  function pickTier(po, amount) {
    return po.tiers.find(t => t.under == null || amount < t.under);
  }

  function approverEmail(business, tier, job) {
    const po = business.config.purchaseOrders;
    switch (tier.approver) {
      case 'foreman':  return job.foreman || po.defaultApproverEmail;
      case 'manager':  return job.manager || po.defaultApproverEmail;
      case 'director': return po.directorEmail || po.defaultApproverEmail;
      default:         return po.defaultApproverEmail;
    }
  }

  function poLabel(business, number) {
    return `${business.config.purchaseOrders.poPrefix || 'PO-'}${number}`;
  }

  function describe(rec) {
    return [
      `Requester:   ${rec.requester} (${rec.requesterPhone})`,
      `Job:         ${rec.job} — ${rec.jobDescription}`,
      `Supplier:    ${rec.supplier}`,
      `For:         ${rec.description}`,
      `Amount:      ${money(rec.amount)}`,
      rec.retrospective
        ? `Purchased:   ALREADY PURCHASED${rec.purchaseDate ? ` (${rec.purchaseDate})` : ''} — retrospective request`
        : `Purchased:   Not yet — PO needed before purchase`,
      `Requested:   ${nzTime(rec.requestedAt)}`,
      `Request ID:  ${rec.id}`
    ].join('\n');
  }

  // ── Decisions ──────────────────────────────────────────────────────────────

  // Issues the PO number. Returns the updated record, or null if it was already decided
  // (two clicks on the same email, or the approver and a forwarded copy).
  function approve(business, requestId, decidedBy) {
    let changed = false;
    const rec = updateRequest(business, requestId, (r, register) => {
      if (r.status !== 'pending') return;
      r.status = 'approved';
      r.poNumber = poLabel(business, register.nextPo++);
      r.decidedBy = decidedBy;
      r.decidedAt = new Date().toISOString();
      changed = true;
    });
    if (!changed) return null;
    logInteraction(`[PO:${business.config.id}] ${rec.id} APPROVED as ${rec.poNumber} by ${decidedBy} — ${rec.requester}, ${rec.supplier}, ${money(rec.amount)}, job ${rec.job}`);
    notifyApproved(business, rec);
    return rec;
  }

  function reject(business, requestId, decidedBy, reason) {
    let changed = false;
    const rec = updateRequest(business, requestId, r => {
      if (r.status !== 'pending') return;
      r.status = 'rejected';
      r.decidedBy = decidedBy;
      r.decidedAt = new Date().toISOString();
      r.rejectReason = reason || '';
      changed = true;
    });
    if (!changed) return null;
    logInteraction(`[PO:${business.config.id}] ${rec.id} REJECTED by ${decidedBy}${reason ? ` ("${reason}")` : ''}`);
    const name = business.config.purchaseOrders.smsSignature || business.config.displayName;
    textRequester(business, rec,
      `${name}: your PO request for ${rec.supplier} (${money(rec.amount)}, job ${rec.job}) was NOT approved.${reason ? ` Reason: ${reason.replace(/[.!?]?$/, '.')}` : ''} Please don't purchase.`);
    emailRequester(business, rec, `PO request NOT approved — ${rec.supplier} ${money(rec.amount)} (job ${rec.job})`, [
      `Your purchase order request was not approved${rec.retrospective ? '' : ', so please don\'t purchase'}.`,
      ...(reason ? ['', `Reason: ${reason}`] : []),
      '',
      describe(rec),
      '',
      `Decided by: ${rec.decidedBy}, ${nzTime(rec.decidedAt)}`
    ].join('\n'));
    syncToSharePoint(business, rec);
    return rec;
  }

  function notifyApproved(business, rec) {
    const po = business.config.purchaseOrders;
    const name = po.smsSignature || business.config.displayName;
    textRequester(business, rec,
      `${name}: PO ${rec.poNumber} APPROVED. ${rec.supplier}, ${money(rec.amount)}, job ${rec.job}. Quote ${rec.poNumber} at the counter and make sure it's on the docket.`);
    const approvedBody = [
      `Your purchase order is approved. Quote ${rec.poNumber} at the counter and make sure it's on the docket.`,
      `The purchase order is attached as a PDF if the supplier wants a copy.`,
      '',
      describe(rec),
      '',
      `Approved by: ${rec.decidedBy}, ${nzTime(rec.decidedAt)}`
    ].join('\n');
    const subject = `PO ${rec.poNumber} approved — ${rec.supplier} ${money(rec.amount)} (job ${rec.job})`;
    buildPoPdf(business, rec)
      .then(pdf => emailRequester(business, rec, subject, approvedBody,
        [{ filename: `${rec.poNumber}.pdf`, content: pdf, contentType: 'application/pdf' }]))
      .catch(e => {
        // Never lose the approval email over a PDF problem — send it without one
        logInteraction(`[ERROR] PO PDF failed (${rec.poNumber}): ${e.message}`);
        emailRequester(business, rec, subject, approvedBody.replace(/\nThe purchase order is attached[^\n]*/, ''));
      });

    sendEmail({
      to: po.accountsEmail || po.defaultApproverEmail,
      subject: `PO ${rec.poNumber} — ${rec.supplier} ${money(rec.amount)} — job ${rec.job}${rec.retrospective ? ' [RETROSPECTIVE]' : ''}`,
      body: [
        `Purchase order ${rec.poNumber} has been issued.`,
        '',
        describe(rec),
        '',
        `Approval:    ${rec.tierLabel}`,
        `Approved by: ${rec.decidedBy}`,
        `Approved at: ${nzTime(rec.decidedAt)}`,
        '',
        `Match the supplier invoice to ${rec.poNumber}.`
      ].join('\n')
    }).catch(e => logInteraction(`[ERROR] PO accounts email failed (${rec.poNumber}): ${e.message}`));

    syncToSharePoint(business, rec);
  }

  function textRequester(business, rec, body) {
    sendSms({ to: rec.requesterPhone, body })
      .then(() => logInteraction(`[PO:${business.config.id}] SMS to ${rec.requesterPhone}: ${body}`))
      .catch(e => {
        logInteraction(`[ERROR] PO SMS failed (${rec.id} → ${rec.requesterPhone}): ${e.message}`);
        const po = business.config.purchaseOrders;
        sendEmail({
          to: po.accountsEmail || po.defaultApproverEmail,
          subject: `PO SMS FAILED — ${rec.requester} was not told about ${rec.poNumber || rec.id}`,
          body: `This text could not be sent to ${rec.requester} (${rec.requesterPhone}):\n\n${body}\n\nError: ${e.message}`
        }).catch(() => {});
      });
  }

  // Copy of the outcome by email, alongside the SMS. testRequesterEmail (POC) redirects
  // every requester's copy to one test inbox without editing the staff list.
  function emailRequester(business, rec, subject, body, attachments) {
    const to = business.config.purchaseOrders.testRequesterEmail || rec.requesterEmail;
    if (!to) return;
    sendEmail({ to, subject, body, attachments })
      .catch(e => logInteraction(`[ERROR] PO requester email failed (${rec.id} → ${to}): ${e.message}`));
  }

  // ── PDF purchase order ─────────────────────────────────────────────────────
  // A one-page A4 PO the requester can show or forward to the supplier. Resolves to a Buffer.
  function buildPoPdf(business, rec) {
    return new Promise((resolve, reject) => {
      const po = business.config.purchaseOrders;
      const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Purchase Order ${rec.poNumber}` } });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const left = 50, width = doc.page.width - 100;
      const issued = new Date(rec.decidedAt).toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', day: 'numeric', month: 'long', year: 'numeric' });

      // Header: company on the left, PO number on the right
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#1d2330')
        .text(po.companyName || business.config.displayName, left, 50, { width: width * 0.6 });
      doc.font('Helvetica').fontSize(9).fillColor('#5c6475')
        .text(business.config.address || '', { width: width * 0.6 })
        .text(business.config.officePhone ? `Phone ${business.config.officePhone}` : '', { width: width * 0.6 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#5c6475')
        .text('PURCHASE ORDER', left, 52, { width, align: 'right' });
      doc.fontSize(22).fillColor('#1d2330').text(rec.poNumber, { width, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor('#5c6475').text(`Issued ${issued}`, { width, align: 'right' });

      let y = 140;
      doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#d0d4dc').stroke();
      y += 16;

      if (rec.retrospective) {
        doc.rect(left, y, width, 24).fill('#fff3cd');
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#7a5b00')
          .text(`RETROSPECTIVE — goods already purchased${rec.purchaseDate ? ` (${rec.purchaseDate})` : ''}`, left + 10, y + 7, { width: width - 20 });
        y += 38;
      }

      const rows = [
        ['Supplier', rec.supplier],
        ['Job', `${rec.job} — ${rec.jobDescription}`],
        ['Description', rec.description],
        ['Amount (estimate)', `${money(rec.amount)} NZD`],
        ['Requested by', `${rec.requester}, ${nzTime(rec.requestedAt)}`],
        ['Approved by', `${rec.decidedBy}, ${nzTime(rec.decidedAt)}`],
        ['Approval level', rec.tierLabel]
      ];
      for (const [label, value] of rows) {
        doc.font('Helvetica').fontSize(10).fillColor('#5c6475').text(label, left, y, { width: 130 });
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#1d2330').text(value, left + 140, y, { width: width - 140 });
        y = Math.max(doc.y, y + 14) + 10;
      }

      y += 10;
      doc.moveTo(left, y).lineTo(left + width, y).strokeColor('#d0d4dc').stroke();
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#1d2330')
        .text(`Supplier: please quote ${rec.poNumber} on your docket and invoice.`, left, y + 16, { width });
      doc.font('Helvetica').fontSize(9).fillColor('#5c6475')
        .text(`Invoices without a purchase order number may be delayed. Request reference ${rec.id}.`, { width });

      doc.end();
    });
  }

  // ── SharePoint mirror ──────────────────────────────────────────────────────
  // Optional: config.purchaseOrders.sharePoint = { site: "host:/sites/Name", list: "Purchase Orders" }
  // plus GRAPH_TENANT_ID / GRAPH_CLIENT_ID / GRAPH_CLIENT_SECRET in app settings.
  // Failures are logged and never block the workflow — the JSON register still has it.
  let graphToken = null;
  const spIds = new Map(); // businessId → { siteId, listId }

  async function graph(method, url, data) {
    if (!graphToken || graphToken.expires < Date.now() + 60000) {
      const r = await axios.post(
        `https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`,
        new URLSearchParams({
          client_id: process.env.GRAPH_CLIENT_ID,
          client_secret: process.env.GRAPH_CLIENT_SECRET,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials'
        })
      );
      graphToken = { value: r.data.access_token, expires: Date.now() + r.data.expires_in * 1000 };
    }
    const r = await axios({
      method, url: `https://graph.microsoft.com/v1.0${url}`, data,
      headers: { Authorization: `Bearer ${graphToken.value}` }
    });
    return r.data;
  }

  async function syncToSharePoint(business, rec) {
    const sp = business.config.purchaseOrders.sharePoint;
    if (!sp || !process.env.GRAPH_CLIENT_ID) return;
    try {
      let ids = spIds.get(business.config.id);
      if (!ids) {
        const site = await graph('get', `/sites/${sp.site}`);
        const list = await graph('get', `/sites/${site.id}/lists/${encodeURIComponent(sp.list)}`);
        ids = { siteId: site.id, listId: list.id };
        spIds.set(business.config.id, ids);
      }
      const fields = {
        Title: rec.id,
        PONumber: rec.poNumber || '',
        Status: rec.status,
        Requester: rec.requester,
        RequesterPhone: rec.requesterPhone,
        Job: rec.job,
        JobDescription: rec.jobDescription,
        Supplier: rec.supplier,
        Details: rec.description,
        Amount: rec.amount,
        Retrospective: rec.retrospective,
        PurchaseDate: rec.purchaseDate || '',
        ApprovalTier: rec.tierLabel,
        Approver: rec.approverEmail || '',
        DecidedBy: rec.decidedBy || '',
        RejectReason: rec.rejectReason || '',
        RequestedAt: rec.requestedAt,
        ...(rec.decidedAt ? { DecidedAt: rec.decidedAt } : {})
      };
      const base = `/sites/${ids.siteId}/lists/${ids.listId}/items`;
      if (rec.spItemId) {
        await graph('patch', `${base}/${rec.spItemId}/fields`, fields);
      } else {
        const item = await graph('post', base, { fields });
        updateRequest(business, rec.id, r => { r.spItemId = item.id; });
      }
    } catch (e) {
      const detail = e.response?.data?.error?.message || e.message;
      logInteraction(`[ERROR] PO SharePoint sync failed (${rec.id}): ${detail}`);
      console.error(`[PO] SharePoint sync failed for ${rec.id}:`, detail);
    }
  }

  // ── Agent webhook ──────────────────────────────────────────────────────────
  // Always 200 with a "message" the agent acts on — a 4xx just makes the LLM say
  // "something went wrong" instead of asking the caller to fix the job number.
  app.post('/purchase-order/:businessId', async (req, res) => {
    const reply = (status, message, extra = {}) => res.status(200).json({ status, message, ...extra });
    let business;
    try { business = getBusiness(req.params.businessId); }
    catch (e) { return res.status(404).send(e.message); }
    const po = business.config.purchaseOrders;
    if (!po) return res.status(404).send(`Business "${business.config.id}" has no purchaseOrders config`);

    try {
      console.log(`[PO:${business.config.id}] Payload:`, req.body);
      let { Job_Number, Supplier, Description, Amount, Already_Purchased, Purchase_Date, caller_id, call_sid } = req.body;
      ({ caller_id, call_sid } = fillFromBridge(call_sid, { caller_id, call_sid }));

      const staff = findStaffByPhone(business, caller_id);
      if (!staff) {
        logInteraction(`[PO:${business.config.id}] Refused — ${caller_id} is not on the staff list`);
        return reply('not_staff', 'This phone number is not registered to a staff member, so a purchase order cannot be raised from it. Apologise, ask them to call back from their work mobile or contact the office, then end the call.');
      }

      // Flash Lite fires this tool the moment a caller says "I need a purchase order",
      // with empty fields, "None" placeholders, or "purchase order" as the description.
      // Answer with everything still missing, in the order the prompt asks for it, so
      // the agent asks the next question instead of reporting a job "not found".
      Supplier = blankIfPlaceholder(Supplier);
      Description = blankIfPlaceholder(Description);
      if (/^(a\s+)?(purchase\s+order|po)$/i.test(Description)) Description = '';
      Job_Number = blankIfPlaceholder(Job_Number);
      Amount = blankIfPlaceholder(Amount);
      const missing = [
        !Description && ['what they need', 'What do you need?'],
        !(parseAmount(Amount) > 0) && ['the cost', 'How much will it cost?'],
        !Supplier && ['the supplier', 'Where will you buy it from?'],
        !Job_Number && ['the job', 'What job is it for?']
      ].filter(Boolean);
      if (missing.length) {
        return reply('missing_details',
          `Nothing has been submitted yet. Still needed: ${missing.map(m => m[0]).join(', ')}. ` +
          `Ask the caller "${missing[0][1]}" and then the remaining questions one at a time. ` +
          `Do not mention errors or anything being "not found". Call this tool again only when you have all four and the caller has confirmed.`);
      }

      const job = findJob(business, Job_Number);
      if (!job) {
        return reply('job_not_found', `Job "${Job_Number}" is not on the job list. Read the number back to the caller and ask them to check it. Only call this tool again once they give a different job number.`);
      }
      const amount = parseAmount(Amount);

      // The LLM sometimes fires a tool twice; the same request on the same call is one PO
      let register = loadRegister(business);
      const dup = register.requests.find(r =>
        r.callSid && r.callSid === call_sid && r.job === job.job && r.amount === amount
        && r.supplier.toLowerCase() === String(Supplier).trim().toLowerCase());
      if (dup) {
        return reply(dup.status, dup.poNumber
          ? `Already approved as ${dup.poNumber}. Do not submit again.`
          : 'Already submitted for approval. Do not submit again.', { po_number: dup.poNumber || '' });
      }

      const tier = pickTier(po, amount);
      const rec = {
        id: `REQ-${String(register.nextRequest++).padStart(4, '0')}`,
        status: 'pending',
        requester: staff.name,
        requesterPhone: staff.phone,
        requesterEmail: staff.email || '',
        job: job.job,
        jobDescription: job.description,
        supplier: String(Supplier).trim(),
        description: String(Description).trim(),
        amount,
        retrospective: isYes(Already_Purchased),
        purchaseDate: isYes(Already_Purchased) ? String(Purchase_Date || '').trim() : '',
        tier: tier.approver,
        tierLabel: tier.label,
        approverEmail: tier.approver === 'self' ? '' : approverEmail(business, tier, job),
        requestedAt: new Date().toISOString(),
        callSid: call_sid || ''
      };
      register.requests.push(rec);
      saveRegister(business, register);
      logInteraction(`[PO:${business.config.id}] ${rec.id} from ${rec.requester}: ${rec.supplier} ${money(amount)} job ${rec.job} → ${rec.tierLabel}${rec.retrospective ? ' [RETROSPECTIVE]' : ''}`);

      if (tier.approver === 'self') {
        const approved = approve(business, rec.id, 'Self-approved');
        const spoken = approved.poNumber.replace(/-/g, '').split('').join(' ');
        return reply('approved',
          `Approved. The PO number is ${approved.poNumber}. Read it back to the caller slowly, character by character ("${spoken}"), and tell them it has also been texted to them.`,
          { po_number: approved.poNumber });
      }

      const host = process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`;
      const link = `${host}/po/review/${business.config.id}/${rec.id}?t=${linkToken(business, rec.id)}`;
      await sendEmail({
        to: rec.approverEmail,
        subject: `PO approval needed — ${rec.requester}: ${rec.supplier} ${money(amount)} (job ${rec.job})${rec.retrospective ? ' [RETROSPECTIVE]' : ''}`,
        body: [
          `${rec.requester} has asked for a purchase order. It needs your approval (${tier.label}).`,
          '',
          describe(rec),
          '',
          `Approve or reject here:`,
          link
        ].join('\n')
      });
      syncToSharePoint(business, rec);

      return reply('pending_approval',
        `Submitted for approval by the ${tier.label.toLowerCase()}. Tell the caller they will get a text with the PO number once it is approved${rec.retrospective ? '' : ', and not to buy until then'}.`);
    } catch (err) {
      console.error('[Error] /purchase-order:', err.message);
      logInteraction(`[ERROR] /purchase-order (${business.config.id}): ${err.message}`);
      return reply('error', 'The request could not be submitted because of a system problem. Apologise and ask the caller to contact the office.');
    }
  });

  // ── Approval pages ─────────────────────────────────────────────────────────
  // GET only shows the request. The decision is a POST from a button: mail scanners
  // (Defender Safe Links etc.) fetch every link in an email, and a GET that approved
  // would approve every PO the moment it was delivered.

  function page(title, inner) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f4f5f7;color:#1d2330;margin:0;padding:24px 16px}
  main{max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
  h1{font-size:20px;margin:0 0 16px} dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 20px}
  dt{color:#5c6475} dd{margin:0;font-weight:500} .flag{background:#fff3cd;padding:8px 12px;border-radius:6px;margin-bottom:16px}
  textarea{width:100%;box-sizing:border-box;min-height:60px;margin:8px 0 12px;font:inherit;padding:8px}
  button{font:inherit;font-weight:600;border:0;border-radius:6px;padding:12px 20px;cursor:pointer;margin-right:8px}
  .ok{background:#1f7a3f;color:#fff} .no{background:#b42318;color:#fff} .status{font-size:18px;font-weight:600}
</style></head><body><main>${inner}</main></body></html>`;
  }

  function detailsHtml(rec) {
    const rows = [
      ['Requester', rec.requester], ['Job', `${rec.job} — ${rec.jobDescription}`],
      ['Supplier', rec.supplier], ['For', rec.description], ['Amount', money(rec.amount)],
      ['Approval', rec.tierLabel], ['Requested', nzTime(rec.requestedAt)], ['Request', rec.id]
    ];
    return (rec.retrospective
      ? `<div class="flag">Retrospective — already purchased${rec.purchaseDate ? ` (${escHtml(rec.purchaseDate)})` : ''}</div>` : '')
      + `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escHtml(v)}</dd>`).join('')}</dl>`;
  }

  function statusHtml(rec) {
    if (rec.status === 'pending') return '<p class="status">Still awaiting a decision</p>';
    return rec.status === 'approved'
      ? `<p class="status">Approved — ${escHtml(rec.poNumber)}</p><p>By ${escHtml(rec.decidedBy)}, ${escHtml(nzTime(rec.decidedAt))}. ${escHtml(rec.requester)} has been texted the PO number.</p>`
      : `<p class="status">Rejected</p><p>By ${escHtml(rec.decidedBy)}, ${escHtml(nzTime(rec.decidedAt))}.${rec.rejectReason ? ` Reason: ${escHtml(rec.rejectReason)}` : ''}</p>`;
  }

  function lookup(req, res) {
    let business;
    try { business = getBusiness(req.params.businessId); }
    catch (e) { res.status(404).send(page('Not found', '<h1>Not found</h1>')); return {}; }
    const token = req.query.t || req.body?.t;
    if (!business.config.purchaseOrders || !tokenValid(business, req.params.requestId, token)) {
      res.status(403).send(page('Invalid link', '<h1>This link is not valid</h1>'));
      return {};
    }
    const rec = loadRegister(business).requests.find(r => r.id === req.params.requestId);
    if (!rec) { res.status(404).send(page('Not found', '<h1>Request not found</h1>')); return {}; }
    return { business, rec, token };
  }

  app.get('/po/review/:businessId/:requestId', (req, res) => {
    const { rec, token } = lookup(req, res);
    if (!rec) return;
    const action = `/po/decide/${encodeURIComponent(req.params.businessId)}/${encodeURIComponent(rec.id)}`;
    const body = rec.status === 'pending'
      ? `<form method="post" action="${action}">
           <input type="hidden" name="t" value="${escHtml(token)}">
           <label for="reason">Reason (optional, sent to ${escHtml(rec.requester)} if rejected)</label>
           <textarea id="reason" name="reason"></textarea>
           <button class="ok" name="decision" value="approve">Approve</button>
           <button class="no" name="decision" value="reject">Reject</button>
         </form>`
      : statusHtml(rec);
    res.status(200).send(page(`PO request ${rec.id}`, `<h1>Purchase order request</h1>${detailsHtml(rec)}${body}`));
  });

  app.post('/po/decide/:businessId/:requestId', (req, res) => {
    const { business, rec } = lookup(req, res);
    if (!rec) return;
    const decidedBy = rec.approverEmail || 'Approver';
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    const result = req.body.decision === 'approve'
      ? approve(business, rec.id, decidedBy)
      : req.body.decision === 'reject' ? reject(business, rec.id, decidedBy, reason) : null;
    // null = already decided (double click, or a second approver got there first)
    const final = result || loadRegister(business).requests.find(r => r.id === rec.id);
    res.status(200).send(page(`PO request ${rec.id}`,
      `<h1>Purchase order request</h1>${detailsHtml(final)}${result ? '' : '<p>This request had already been decided.</p>'}${statusHtml(final)}`));
  });
};
