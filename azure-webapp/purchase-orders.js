// purchase-orders.js — phone-based purchase order workflow (Gibbons Rail POC)
//
//   Staff ring the receptionist and ask for a PO → agent collects what / cost / supplier / job
//     → POST /purchase-order/:businessId        (ElevenLabs webhook tool)
//         validates requester (caller ID) and job, builds the approval cascade by amount
//         ├── under selfApproveUnder → PO number issued straight away, read back on the call
//         └── otherwise → Site Supervisor → Project Manager → Director, stopping at the
//             first level whose limit covers the amount. Each level is emailed a review
//             link only once the level below has approved:
//               → GET  /po/review/:businessId/:requestId?s=step&a=approver&t=…  (page)
//               → POST /po/decide/:businessId/:requestId                        (Approve / Reject)
//   On final approval: sequential PO number, SMS to requester (Sinch / MessageMedia),
//   PDF to requester, summary to accounts, register updated (JSON, mirrored to SharePoint).
//   A rejection at any level ends the request.
//
// Config lives in the business's config.json under "purchaseOrders". Who holds each role
// is per job, in jobs.csv (loaded by index.js as business.jobs).

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

  // One link per approver per step, so the register records who actually clicked
  // (a level can have several people, e.g. either director) and a supervisor's link
  // can't be reused to approve the director's step.
  function linkToken(business, requestId, step, approverIndex) {
    return crypto.createHmac('sha256', linkSecret(business))
      .update(`${business.config.id}:${requestId}:${step}:${approverIndex}`).digest('base64url');
  }

  function tokenValid(business, requestId, step, approverIndex, token) {
    const expected = Buffer.from(linkToken(business, requestId, step, approverIndex));
    const given = Buffer.from(String(token || ''));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  function reviewLink(business, rec, step, approverIndex) {
    const q = new URLSearchParams({ s: step, a: approverIndex, t: linkToken(business, rec.id, step, approverIndex) });
    return `${rec.linkBase}/po/review/${business.config.id}/${rec.id}?${q}`;
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
  // Falls back to the job's name ("Benneydale", "the CRL job") when exactly one job
  // matches — the agent is meant to convert names to numbers, but doesn't always.
  function findJob(business, jobNumber) {
    const key = jobKey(jobNumber).replace(/^the|job$/g, '');
    if (!key) return null;
    const byNumber = business.jobs.find(j => jobKey(j.job) === key);
    if (byNumber || key.length < 3) return byNumber || null;
    const byName = business.jobs.filter(j => jobKey(j.description).includes(key));
    return byName.length === 1 ? byName[0] : null;
  }

  // A jobs.csv role cell → approvers. Each ";"-separated entry is an email address or a
  // staff name looked up in the staff list ("Karl Donovan"). Falls back to the
  // business-wide default for that role when the cell is blank or nobody resolves.
  function resolveApprovers(business, cell, role) {
    const po = business.config.purchaseOrders;
    const resolve = entries => entries.map(e => e.trim()).filter(Boolean).map(e => {
      if (e.includes('@')) {
        const staff = Object.values(business.calleeDirectory).find(s => (s.email || '').toLowerCase() === e.toLowerCase());
        return { name: staff?.name || e, email: e };
      }
      const staff = business.calleeDirectory[e.toLowerCase()];
      if (!staff?.email) logInteraction(`[PO:${business.config.id}] Approver "${e}" (${role}) is not in the staff list with an email`);
      return staff?.email ? { name: staff.name, email: staff.email } : null;
    }).filter(Boolean);
    const fromJob = resolve(String(cell || '').split(';'));
    if (fromJob.length) return fromJob;
    return resolve(String(po.defaultApprovers?.[role] || po.defaultApproverEmail || '').split(';'));
  }

  // The cascade: climb approvalLevels in order, stopping at the first level whose
  // "upTo" covers the amount (the last level has none and covers everything).
  // Under selfApproveUnder there is no chain at all — the PO is issued on the call.
  //
  // Nobody approves their own request: a level where the requester is an approver
  // is left out, and if that was the top level the next one up takes its place, so
  // a project manager's $300 request goes supervisor → director, not to themselves.
  function buildChain(business, amount, job, requester) {
    const po = business.config.purchaseOrders;
    if (amount < (po.selfApproveUnder || 0)) return [];
    const levels = po.approvalLevels;
    let top = levels.findIndex(l => l.upTo == null || amount < l.upTo);
    if (top < 0) top = levels.length - 1;
    const isRequester = a => a.email.toLowerCase() === (requester.email || '').toLowerCase();

    const chain = [];
    for (let i = 0; i < levels.length && i <= top; i++) {
      const approvers = resolveApprovers(business, job[levels[i].role], levels[i].role).filter(a => !isRequester(a));
      if (!approvers.length) {
        // Only the requester holds this level. At the top, escalate one level further.
        if (i === top && top < levels.length - 1) top++;
        continue;
      }
      chain.push({ role: levels[i].role, label: levels[i].label, approvers, status: 'pending' });
    }
    // A director asking for more than the others can approve, with no other director listed
    if (!chain.length) {
      chain.push({ role: 'default', label: 'Approver', status: 'pending',
        approvers: [{ name: po.defaultApproverEmail, email: po.defaultApproverEmail }] });
    }
    return chain;
  }

  const firstNames = list => list.map(a => a.name).join(' or ');

  // "Site Supervisor: Dave Smith (24/10/2026, 9:01 am)" for each level approved so far
  function approvalTrail(rec) {
    if (!rec.chain?.length) return [`Self-approved (under the self-approval limit)`];
    return rec.chain.filter(c => c.status === 'approved')
      .map(c => `${c.label}: ${c.decidedBy} (${nzTime(c.decidedAt)})`);
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

  // Self-approval: issues the PO number on the call, no chain
  function selfApprove(business, requestId) {
    const rec = updateRequest(business, requestId, (r, register) => {
      r.status = 'approved';
      r.poNumber = poLabel(business, register.nextPo++);
      r.decidedBy = 'Self-approved';
      r.decidedAt = new Date().toISOString();
    });
    logInteraction(`[PO:${business.config.id}] ${rec.id} SELF-APPROVED as ${rec.poNumber} — ${rec.requester}, ${rec.supplier}, ${money(rec.amount)}, job ${rec.job}`);
    notifyApproved(business, rec);
    return rec;
  }

  // One approver's yes at one step. Moves the request up to the next level, or at the
  // last level issues the PO number. Returns null if this step was already decided
  // (double click, or the other director got there first).
  function approveStep(business, requestId, step, approverIndex) {
    let outcome = null;
    const rec = updateRequest(business, requestId, (r, register) => {
      if (r.status !== 'pending' || r.step !== step) return;
      const level = r.chain[step];
      level.status = 'approved';
      level.decidedBy = level.approvers[approverIndex].name;
      level.decidedAt = new Date().toISOString();
      if (step < r.chain.length - 1) {
        r.step++;
        outcome = 'next';
      } else {
        r.status = 'approved';
        r.poNumber = poLabel(business, register.nextPo++);
        r.decidedBy = `${level.decidedBy} (${level.label})`;
        r.decidedAt = level.decidedAt;
        outcome = 'final';
      }
    });
    if (!outcome) return null;
    const level = rec.chain[step];
    if (outcome === 'final') {
      logInteraction(`[PO:${business.config.id}] ${rec.id} APPROVED as ${rec.poNumber} — final approval by ${level.decidedBy} (${level.label})`);
      notifyApproved(business, rec);
    } else {
      const next = rec.chain[rec.step];
      logInteraction(`[PO:${business.config.id}] ${rec.id} approved by ${level.decidedBy} (${level.label}) → now with ${next.label}`);
      requestApproval(business, rec).catch(e =>
        logInteraction(`[ERROR] PO approval email failed (${rec.id} → ${next.label}): ${e.message}`));
      emailRequester(business, rec, `PO request ${rec.id} — approved by ${level.label}, now with ${next.label}`, [
        `${level.decidedBy} (${level.label}) has approved your request. It now needs approval from the ${next.label} (${firstNames(next.approvers)}).`,
        `You'll get a text with the PO number once it's fully approved.`,
        '',
        describe(rec)
      ].join('\n'));
      syncToSharePoint(business, rec);
    }
    return rec;
  }

  // Emails every approver at the request's current step their own link
  async function requestApproval(business, rec) {
    const level = rec.chain[rec.step];
    const done = approvalTrail(rec);
    const after = rec.chain.slice(rec.step + 1).map(c => c.label);
    await Promise.all(level.approvers.map((a, i) => sendEmail({
      to: a.email,
      subject: `PO approval needed (${level.label}) — ${rec.requester}: ${rec.supplier} ${money(rec.amount)} (job ${rec.job})${rec.retrospective ? ' [RETROSPECTIVE]' : ''}`,
      body: [
        `${rec.requester} has asked for a purchase order. It needs your approval as ${level.label}` +
          (rec.chain.length > 1 ? ` (step ${rec.step + 1} of ${rec.chain.length}).` : '.'),
        ...(done.length ? ['', 'Already approved by:', ...done.map(d => `  ${d}`)] : []),
        ...(after.length ? ['', `After you it goes to: ${after.join(', then ')}.`] : []),
        ...(level.approvers.length > 1 ? ['', `Also sent to ${firstNames(level.approvers.filter((_, j) => j !== i))} — whoever decides first, decides.`] : []),
        '',
        describe(rec),
        '',
        'Approve or reject here:',
        reviewLink(business, rec, rec.step, i)
      ].join('\n')
    })));
  }

  function reject(business, requestId, step, approverIndex, reason) {
    let changed = false;
    const rec = updateRequest(business, requestId, r => {
      if (r.status !== 'pending' || r.step !== step) return;
      const level = r.chain[step];
      level.status = 'rejected';
      level.decidedBy = level.approvers[approverIndex].name;
      level.decidedAt = new Date().toISOString();
      r.status = 'rejected';
      r.decidedBy = `${level.decidedBy} (${level.label})`;
      r.decidedAt = level.decidedAt;
      r.rejectReason = reason || '';
      changed = true;
    });
    if (!changed) return null;
    logInteraction(`[PO:${business.config.id}] ${rec.id} REJECTED by ${rec.decidedBy}${reason ? ` ("${reason}")` : ''}`);
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
      'Approved by:',
      ...approvalTrail(rec).map(t => `  ${t}`)
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
        'Approved by:',
        ...approvalTrail(rec).map(t => `  ${t}`),
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
        ...(rec.chain?.length
          ? rec.chain.map(c => [`Approved — ${c.label}`, `${c.decidedBy}, ${nzTime(c.decidedAt)}`])
          : [['Approved', `Self-approved, ${nzTime(rec.decidedAt)}`]])
      ];
      for (const [label, value] of rows) {
        doc.font('Helvetica').fontSize(10).fillColor('#5c6475').text(label, left, y, { width: 165 });
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#1d2330').text(value, left + 175, y, { width: width - 175 });
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
        Approver: rec.status === 'pending' ? `${rec.chain[rec.step].label}: ${firstNames(rec.chain[rec.step].approvers)}` : '',
        DecidedBy: approvalTrail(rec).join('; ') + (rec.status === 'rejected' ? `; REJECTED by ${rec.decidedBy}` : ''),
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
      if (/^(an?\s+)?(purchase\s+order|p\.?\s?o\.?)(\s+number)?$/i.test(Description)) Description = '';
      Job_Number = blankIfPlaceholder(Job_Number);
      Amount = blankIfPlaceholder(Amount);
      const missing = [
        !Description && ['what they are buying', 'What are you buying?'],
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

      const chain = buildChain(business, amount, job, staff);
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
        tierLabel: chain.length ? chain.map(c => c.label).join(' → ') : `Self-approved (under ${money(po.selfApproveUnder)})`,
        chain,
        step: 0,
        linkBase: process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`,
        requestedAt: new Date().toISOString(),
        callSid: call_sid || ''
      };
      register.requests.push(rec);
      saveRegister(business, register);
      logInteraction(`[PO:${business.config.id}] ${rec.id} from ${rec.requester}: ${rec.supplier} ${money(amount)} job ${rec.job} → ${rec.tierLabel}${rec.retrospective ? ' [RETROSPECTIVE]' : ''}`);

      if (!chain.length) {
        const approved = selfApprove(business, rec.id);
        const spoken = approved.poNumber.replace(/-/g, '').split('').join(' ');
        return reply('approved',
          `Approved. The PO number is ${approved.poNumber}. Read it back to the caller slowly, character by character ("${spoken}"), and tell them it has also been texted to them.`,
          { po_number: approved.poNumber });
      }

      await requestApproval(business, rec);
      syncToSharePoint(business, rec);

      // Spoken aloud, so people's names only — never read an email address to the caller
      const route = chain.map(c => {
        const names = firstNames(c.approvers.filter(a => !a.name.includes('@')));
        return `the ${c.label.toLowerCase()}${names ? ` (${names})` : ''}`;
      });
      return reply('pending_approval',
        `Submitted for approval. It goes to ${route.length > 1 ? `${route.slice(0, -1).join(', then ')}, and finally ${route.at(-1)}` : route[0]}. ` +
        `Tell the caller who it has gone to, that they will get a text with the PO number once it is fully approved${rec.retrospective ? '' : ', and not to buy until then'}.`);
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
  h2{font-size:15px;margin:0 0 8px} .chain{list-style:none;padding:0;margin:0 0 20px} .chain li{padding:4px 0}
  .mark{display:inline-block;width:18px;font-weight:700}
</style></head><body><main>${inner}</main></body></html>`;
  }

  function detailsHtml(rec) {
    const rows = [
      ['Requester', rec.requester], ['Job', `${rec.job} — ${rec.jobDescription}`],
      ['Supplier', rec.supplier], ['For', rec.description], ['Amount', money(rec.amount)],
      ['Requested', nzTime(rec.requestedAt)], ['Request', rec.id]
    ];
    return (rec.retrospective
      ? `<div class="flag">Retrospective — already purchased${rec.purchaseDate ? ` (${escHtml(rec.purchaseDate)})` : ''}</div>` : '')
      + `<dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escHtml(v)}</dd>`).join('')}</dl>`
      + chainHtml(rec);
  }

  // The approval cascade with each level's state: ✓ approved, ✗ rejected, → current, · waiting
  function chainHtml(rec) {
    if (!rec.chain?.length) return '';
    const items = rec.chain.map((c, i) => {
      const mark = c.status === 'approved' ? '✓' : c.status === 'rejected' ? '✗'
        : rec.status === 'pending' && i === rec.step ? '→' : '·';
      const who = c.decidedBy ? `${escHtml(c.decidedBy)}, ${escHtml(nzTime(c.decidedAt))}` : escHtml(firstNames(c.approvers));
      return `<li><span class="mark">${mark}</span> <b>${escHtml(c.label)}</b> — ${who}</li>`;
    }).join('');
    return `<h2>Approvals</h2><ol class="chain">${items}</ol>`;
  }

  function statusHtml(rec) {
    if (rec.status === 'pending') return `<p class="status">Waiting on the ${escHtml(rec.chain[rec.step].label)}</p>`;
    return rec.status === 'approved'
      ? `<p class="status">Approved — ${escHtml(rec.poNumber)}</p><p>${escHtml(rec.requester)} has been texted the PO number.</p>`
      : `<p class="status">Rejected</p><p>By ${escHtml(rec.decidedBy)}, ${escHtml(nzTime(rec.decidedAt))}.${rec.rejectReason ? ` Reason: ${escHtml(rec.rejectReason)}` : ''}</p>`;
  }

  function lookup(req, res) {
    let business;
    try { business = getBusiness(req.params.businessId); }
    catch (e) { res.status(404).send(page('Not found', '<h1>Not found</h1>')); return {}; }
    const src = req.method === 'POST' ? req.body : req.query;
    const step = Number(src.s), approverIndex = Number(src.a), token = src.t;
    const rec = business.config.purchaseOrders && loadRegister(business).requests.find(r => r.id === req.params.requestId);
    // Requests from before the cascade have no chain and their links no longer verify
    if (!rec?.chain?.[step]?.approvers?.[approverIndex]
        || !tokenValid(business, rec.id, step, approverIndex, token)) {
      res.status(403).send(page('Invalid link', '<h1>This link is not valid</h1>'));
      return {};
    }
    return { business, rec, step, approverIndex, token };
  }

  app.get('/po/review/:businessId/:requestId', (req, res) => {
    const { rec, step, approverIndex, token } = lookup(req, res);
    if (!rec) return;
    const level = rec.chain[step];
    const action = `/po/decide/${encodeURIComponent(req.params.businessId)}/${encodeURIComponent(rec.id)}`;
    const yourTurn = rec.status === 'pending' && rec.step === step;
    const body = yourTurn
      ? `<p>You are approving as <b>${escHtml(level.label)}</b> (${escHtml(level.approvers[approverIndex].name)}).</p>
         <form method="post" action="${action}">
           <input type="hidden" name="s" value="${step}"><input type="hidden" name="a" value="${approverIndex}">
           <input type="hidden" name="t" value="${escHtml(token)}">
           <label for="reason">Reason (optional, sent to ${escHtml(rec.requester)} if rejected)</label>
           <textarea id="reason" name="reason"></textarea>
           <button class="ok" name="decision" value="approve">Approve</button>
           <button class="no" name="decision" value="reject">Reject</button>
         </form>`
      : `${level.status !== 'pending' ? '<p>The ' + escHtml(level.label) + ' step has already been decided.</p>' : ''}${statusHtml(rec)}`;
    res.status(200).send(page(`PO request ${rec.id}`, `<h1>Purchase order request</h1>${detailsHtml(rec)}${body}`));
  });

  app.post('/po/decide/:businessId/:requestId', (req, res) => {
    const { business, rec, step, approverIndex } = lookup(req, res);
    if (!rec) return;
    const reason = String(req.body.reason || '').trim().slice(0, 300);
    const result = req.body.decision === 'approve'
      ? approveStep(business, rec.id, step, approverIndex)
      : req.body.decision === 'reject' ? reject(business, rec.id, step, approverIndex, reason) : null;
    // null = already decided (double click, or the other approver at this level got there first)
    const latest = result || loadRegister(business).requests.find(r => r.id === rec.id);
    const passedOn = result && result.status === 'pending'
      ? `<p class="status">Approved — passed to the ${escHtml(result.chain[result.step].label)}</p>` : statusHtml(latest);
    res.status(200).send(page(`PO request ${rec.id}`,
      `<h1>Purchase order request</h1>${detailsHtml(latest)}${result ? '' : '<p>This step had already been decided.</p>'}${passedOn}`));
  });
};
