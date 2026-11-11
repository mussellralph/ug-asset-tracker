'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const outputRoot = process.env.JOBCARDS_DIR || '/jobcards';
const allowedCompanies = new Set(['SINABO', 'UES', 'USS']);
const maxBodyBytes = 4 * 1024 * 1024;

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBodyBytes) {
        reject(Object.assign(new Error('Request is too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function clean(value, limit = 500) {
  return String(value ?? '').trim().slice(0, limit);
}

function signatureBuffer(value) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  if (!match) throw new Error('Both signatures must be captured before submitting.');
  const bytes = Buffer.from(match[1], 'base64');
  if (!bytes.length || bytes.length > 400 * 1024) throw new Error('Signature image is invalid or too large.');
  return bytes;
}

function createPdf(data, signer, signatures) {
  return new Promise((resolve, reject) => {
    const utility = data.company === 'USS' || data.company === 'UES';
    const doc = new PDFDocument({ size: 'A4', margin: 16, info: { Title: (data.company || 'SINABO') + ' Job Card', Author: signer } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const left = 20, width = doc.page.width - 40;
    const ink = '#20252d', muted = '#68717d', red = '#a71932', rule = '#aeb5bf';
    const people = Array.isArray(data.personnel) ? [...new Set(data.personnel.map(n => clean(n, 120)).filter(Boolean))].slice(0, 20) : [];
    const checks = Array.isArray(data.checks)
      ? data.checks.slice(0, 16).filter(row => row.label !== 'Battery electrolyte level')
      : [];
    const readings = Array.isArray(data.readings) ? data.readings.slice(0, 20) : [];
    const runTests = Array.isArray(data.runTests)
      ? data.runTests.slice(0, 12).filter(row => row.label !== 'Check speed cut out relay')
      : [];
    const controlTests = Array.isArray(data.controlTests) ? data.controlTests.slice(0, 8) : [];
    const tests = [...runTests, ...controlTests];
    const parts = Array.isArray(data.parts) ? data.parts.slice(0, 20) : [];

    function fit(value, w, font = 'Helvetica', size = 6, max = 1000) {
      let s = clean(value, max).replace(/\s+/g, ' ');
      if (!s) return '-';
      doc.font(font).fontSize(size);
      if (doc.widthOfString(s) <= w) return s;
      while (s.length > 1 && doc.widthOfString(s + '...') > w) s = s.slice(0, -1);
      return s.trimEnd() + '...';
    }
    function wrap(value, w, size, maxLines, max = 3000) {
      const words = clean(value, max).replace(/\s+/g, ' ').split(' ').filter(Boolean);
      if (!words.length) return ['-'];
      doc.font('Helvetica').fontSize(size);
      const out = [];
      let line = '', clipped = false;
      for (const word of words) {
        const candidate = line ? line + ' ' + word : word;
        if (doc.widthOfString(candidate) <= w) { line = candidate; continue; }
        if (line) out.push(line);
        line = word;
        if (out.length >= maxLines) { clipped = true; break; }
      }
      if (line && out.length < maxLines) out.push(line);
      if (clipped || (out.length === maxLines && words.join(' ').length > out.join(' ').length)) out[out.length - 1] = fit(out[out.length - 1] + '...', w, 'Helvetica', size, max);
      return out.length ? out : ['-'];
    }
    function heading(text, y, x = left, w = width) {
      doc.font('Helvetica-Bold').fontSize(7.2).fillColor(red).text(text.toUpperCase(), x, y, { width: w, lineBreak: false });
      doc.moveTo(x, y + 9).lineTo(x + w, y + 9).strokeColor(rule).lineWidth(0.55).stroke();
      return y + 12;
    }
    function field(label, value, x, y, w, h, maxLines = 1) {
      doc.rect(x, y, w, h).fillAndStroke('#f2f3f5', rule);
      doc.font('Helvetica').fontSize(5.8).fillColor(muted).text(fit(label, w - 8, 'Helvetica', 5.8, 120), x + 4, y + 2, { width: w - 8, lineBreak: false });
      wrap(value, w - 8, 7.2, maxLines, 1000).forEach((s, i) => doc.font('Helvetica-Bold').fontSize(7.2).fillColor(ink)
        .text(s, x + 4, y + 9 + i * 8.2, { width: w - 8, lineBreak: false }));
    }
    function grid(items, cols, y, h = 21, lines = 1) {
      const gap = 4, cw = (width - gap * (cols - 1)) / cols;
      items.forEach(([label, value], i) => field(label, value, left + (i % cols) * (cw + gap), y + Math.floor(i / cols) * h, cw, h, lines));
      return y + Math.ceil(items.length / cols) * h;
    }
    function block(label, value, x, y, w, h, count = 3, size = 6.1, limit = 3000) {
      doc.rect(x, y, w, h).fillAndStroke('#fff', rule);
      doc.font('Helvetica-Bold').fontSize(5.8).fillColor(muted).text(fit(label, w - 8, 'Helvetica-Bold', 5.8, 120), x + 4, y + 3, { width: w - 8, lineBreak: false });
      wrap(value, w - 8, size, count, limit).forEach((s, i) => doc.font('Helvetica').fontSize(size).fillColor(ink)
        .text(s, x + 4, y + 11 + i * (size + 1), { width: w - 8, lineBreak: false }));
    }
    function stack(label, rows, x, y, w, h) {
      doc.rect(x, y, w, h).fillAndStroke('#fff', rule);
      doc.font('Helvetica-Bold').fontSize(7.2).fillColor(red).text(label.toUpperCase(), x + 4, y + 3, { width: w - 8, lineBreak: false });
      const rh = (h - 14) / rows.length;
      rows.forEach(([name, value], i) => {
        const yy = y + 13 + i * rh, lw = w * 0.38;
        doc.font('Helvetica-Bold').fontSize(5.5).fillColor(muted).text(fit(name, lw - 6, 'Helvetica-Bold', 5.2, 80), x + 4, yy, { width: lw - 6, lineBreak: false });
        doc.font('Helvetica').fontSize(5.8).fillColor(ink).text(fit(value, w - lw - 10, 'Helvetica', 5.8, 200), x + lw, yy, { width: w - lw - 6, lineBreak: false });
        if (i < rows.length - 1) doc.moveTo(x + 4, yy + rh - 1).lineTo(x + w - 4, yy + rh - 1).strokeColor('#ddd').lineWidth(0.3).stroke();
      });
    }
    function table(label, headers, rows, x, y, w, ratios) {
      doc.font('Helvetica-Bold').fontSize(6).fillColor(red).text(label.toUpperCase(), x, y, { width: w, lineBreak: false });
      const hy = y + 9, widths = ratios.map(v => w * v);
      let xx = x;
      headers.forEach((s, i) => {
        doc.rect(xx, hy, widths[i], 8).fillAndStroke('#e0e3e7', rule);
        doc.font('Helvetica-Bold').fontSize(5.5).fillColor(muted).text(fit(s, widths[i] - 4, 'Helvetica-Bold', 5.5, 60), xx + 2, hy + 1.5, { width: widths[i] - 4, lineBreak: false });
        xx += widths[i];
      });
      rows.forEach((row, ri) => {
        const yy = hy + 8 + ri * 9.7;
        let cx = x;
        row.forEach((v, ci) => {
          const font = ci === 0 ? 'Helvetica-Bold' : 'Helvetica';
          doc.rect(cx, yy, widths[ci], 9.7).fillAndStroke(ri % 2 ? '#fff' : '#f8f8f9', '#d3d7dc');
          doc.font(font).fontSize(6.0).fillColor(ink).text(fit(v, widths[ci] - 4, font, 6.0, 240), cx + 2, yy + 1.5, { width: widths[ci] - 4, lineBreak: false });
          cx += widths[ci];
        });
      });
      return hy + 8 + rows.length * 9.7;
    }
    function signBlock(y) {
      y = heading(utility ? 'Customer and technician signatures' : 'Acknowledgement and signatures', y);
      const gap = 10, cw = (width - gap) / 2;
      field('Customer representative name (print)', data.customerRepName, left, y, cw, 19);
      field('Serviceman name (print)', signer, left + cw + gap, y, cw, 19);
      const sy = y + 22, sh = 60;
      doc.image(signatures.customer, left, sy, { fit: [cw, sh], align: 'center', valign: 'center' });
      doc.image(signatures.serviceman, left + cw + gap, sy, { fit: [cw, sh], align: 'center', valign: 'center' });
      doc.moveTo(left, sy + sh).lineTo(left + cw, sy + sh).strokeColor(rule).stroke();
      doc.moveTo(left + cw + gap, sy + sh).lineTo(left + width, sy + sh).strokeColor(rule).stroke();
      doc.font('Helvetica').fontSize(5.5).fillColor(muted).text('Customer representative signature', left, sy + sh + 2, { width: cw, align: 'center', lineBreak: false });
      doc.text('Technician / serviceman signature', left + cw + gap, sy + sh + 2, { width: cw, align: 'center', lineBreak: false });
      return sy + sh + 11;
    }

    const logo = data.company === 'UES' ? ['ues-logo.jpg', 180, 111 / 240] : data.company === 'USS' ? ['uss-logo.png', 190, 1032 / 2831] : ['sinabo-logo.png', 150, 120 / 326];
    const logoH = logo[1] * logo[2], logoY = 18;
    doc.image(path.join(__dirname, 'assets', logo[0]), (doc.page.width - logo[1]) / 2, logoY, { width: logo[1], height: logoH });
    if (!utility && clean(data.serviceType)) {
      const serviceTypeWidth = 124;
      const serviceTypeHeight = 22;
      field('Service type', data.serviceType, left + width - serviceTypeWidth,
        logoY + (logoH - serviceTypeHeight) / 2, serviceTypeWidth, serviceTypeHeight);
    }
    let y = logoY + logoH + 3;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text((utility ? 'JOB CARD NO. ' : 'SERVICE SCHEDULE ') + clean(data.serviceScheduleNo, 50), left, y, { width, align: 'center', lineBreak: false });
    y += 14;

    if (utility) {
      y = grid([['Date', data.date], ['Job No.', data.jobNo], ['Customer', data.customer], ['Quote No.', data.quoteNo], ['Order No.', data.orderNo], ['Required Date', data.requiredDate], ['Site', data.site]], 3, y, 28) + 4;
      y = heading('Personnel, odometer and time on site', y);
      const gap = 5, cw = (width - gap * 2) / 3;
      block('Personnel', people.join(', ') || 'None recorded', left, y, cw, 108, 8, 6.5, 1500);
      stack('Odometer', [['Opening', data.odometerOpening], ['Closing', data.odometerClosing], ['Total kilometres', data.kilometres]], left + cw + gap, y, cw, 108);
      stack('Time on site', [['Start', data.timeStart], ['Finish', data.timeFinish], ['Total hours', data.totalHours]], left + (cw + gap) * 2, y, cw, 108);
      y += 112;
      y = heading('Job description and works', y);
      const tg = 5, tw = (width - tg * 2) / 3;
      block('Tasks', data.tasks, left, y, tw, 115, 8, 6.6, 3000);
      block('Works complete', data.worksComplete, left + tw + tg, y, tw, 115, 8, 6.6, 1500);
      block('Works in progress', data.worksInProgress, left + (tw + tg) * 2, y, tw, 115, 8, 6.6, 1500);
      y += 119;
      y = heading('Additional work / equipment', y);
      y = grid([['Additional work / equipment', data.additionalWork], ['Requested by', data.requestedBy], ['Request date', data.requestDate], ['Billing', data.billing], ['Travel time', data.travelTime], ['Time on site', data.timeOnSite]], 3, y, 36, 2) + 4;
      y = heading('Remarks', y);
      block('Remarks', data.remarks, left, y, width, 82, 8, 6.4, 2000);
      y += 86;
    } else {
      y = grid([
        ['Job No.', data.jobNo || data.unitRef], ['Date', data.date], ['Service Schedule No.', data.serviceScheduleNo],
        ['Customer', data.customer], ['Order number', data.orderNo], ['Site', data.site],
        ['Hour metre', data.hourMetre], ['Engine type', data.engineType], ['Alternator type', data.alternatorType]
      ], 3, y, 24) + 4;
      y = heading('Personnel on site', y);
      block('Personnel', people.join(', ') || 'None recorded', left, y, width, 28, 2, 6, 1500);
      y += 32;
      const gap = 10, tw = (width - gap) / 2;
      const checkRows = checks.map(r => [r.label, r.result, r.notes]);
      const readingRows = readings.map(r => [r.label, r.unit ? (r.value || '') + ' ' + r.unit : r.value, r.notes]);
      const pair = (a, b, at) => Math.max(table(a.title, a.headers, a.rows, left, at, tw, a.ratios), table(b.title, b.headers, b.rows, left + tw + gap, at, tw, b.ratios));
      y = pair({ title: 'Generator checks', headers: ['Check', 'Result', 'Notes'], rows: checkRows, ratios: [0.43, 0.21, 0.36] },
        { title: 'Alternator and generator readings', headers: ['Reading', 'Value', 'Notes'], rows: readingRows, ratios: [0.48, 0.2, 0.32] }, y) + 5;
      const testRows = tests.map(r => [r.label, r.unit ? (r.result || '') + ' ' + r.unit : r.result, r.notes]);
      y = pair({ title: 'Run engine and control panel tests', headers: ['Test', 'Result', 'Notes'], rows: testRows, ratios: [0.5, 0.2, 0.3] },
        { title: 'Parts / consumables supplied', headers: ['Item', 'Qty', 'Notes'], rows: parts.map(r => [r.item, r.quantity, r.notes]), ratios: [0.52, 0.16, 0.32] }, y) + 5;
      function formatTimeRange(start, finish, savedDuration) {
        if (!start && !finish) return savedDuration;
        return `Start ${start || '-'} / Finish ${finish || '-'}`;
      }
      y = grid([
        ['Travel time', formatTimeRange(data.travelStart, data.travelFinish, data.travelTime)],
        ['Time on site', formatTimeRange(data.siteStart, data.siteFinish, data.timeOnSite)],
        ['Kilometres', data.kilometres]
      ], 3, y, 22) + 4;
      block('Remarks', data.remarks, left, y, width, 34, 3, 6.4, 2000);
      y += 36;
    }
    y = signBlock(y + 1);
    if (y < doc.page.height - 25) doc.font('Helvetica-Bold').fontSize(6.2).fillColor(muted).text('Thank you for your business.', left, y + 3, { width, align: 'center', lineBreak: false });
    doc.end();
  });
}
async function handleSubmit(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length > 256) return send(res, 401, { error: 'Please sign in before submitting a job card.' });
  let client;
  let finalPath;
  let fileWritten = false;
  try {
    const data = await readJson(req);
    const company = clean(data.company, 20).toUpperCase();
    if (!allowedCompanies.has(company)) return send(res, 400, { error: 'Select a valid company.' });
    if (company === 'SINABO' && (!clean(data.customer) || !clean(data.site) || !clean(data.serviceScheduleNo) || !clean(data.jobNo || data.unitRef))) return send(res, 400, { error: 'Complete the customer, site, service schedule number and Job No.' });
    if ((company === 'USS' || company === 'UES') && (!clean(data.customer) || !clean(data.site) || !clean(data.serviceScheduleNo) || !clean(data.date))) return send(res, 400, { error: 'Complete the date, customer, site and Job No.' });
    const clientId = clean(data.clientId, 120);
    if (clientId.length < 8) return send(res, 400, { error: 'Submission reference is missing. Please try again.' });

    const signatures = { customer: signatureBuffer(data.customerSignature), serviceman: signatureBuffer(data.servicemanSignature) };
    client = await pool.connect();
    const session = await client.query(`
      SELECT a.name
        FROM public.staff_sessions s
        JOIN public.staff_accounts a ON a.name = s.staff_name
       WHERE s.token = $1 AND s.expires_at > NOW() AND a.active IS TRUE
       LIMIT 1`, [token]);
    if (!session.rowCount) return send(res, 401, { error: 'Your sign-in session expired. Sign in again to submit.' });
    const submittedBy = session.rows[0].name;
    if (clean(data.servicemanName, 160) !== submittedBy) return send(res, 403, { error: `Sign in as ${clean(data.servicemanName, 160) || 'the serviceman'} to upload this signed job card.` });
    const id = crypto.createHash('sha256').update(clientId).digest('hex').slice(0, 32);
    const previous = await client.query('SELECT company, file_name AS "fileName", submitted_by AS "submittedBy" FROM public.job_cards WHERE id = $1', [id]);
    if (previous.rowCount) {
      const saved = previous.rows[0];
      if (saved.company !== company) return send(res, 409, { error: 'This submission reference is already recorded under another company.' });
      const savedPath = path.join(outputRoot, saved.company, saved.fileName);
      try {
        await fs.access(savedPath);
        return send(res, 200, { ok: true, id, ...saved, alreadySubmitted: true });
      } catch {}
      // The database can retain the submission record after a share was detached or its PDF was removed.
      // Rebuild the missing file before reporting success for a retry.
      finalPath = savedPath;
      await fs.mkdir(path.dirname(savedPath), { recursive: true });
      const pdf = await createPdf(data, submittedBy, signatures);
      await fs.writeFile(savedPath, pdf, { flag: 'wx' });
      fileWritten = true;
      return send(res, 200, { ok: true, id, ...saved, restoredFile: true });
    }
    const jobNo = clean(company === 'USS' || company === 'UES' ? data.serviceScheduleNo : (data.jobNo || data.unitRef), 80).replace(/[^A-Za-z0-9_-]/g, '_');
    const fileName = `${company}_JC_${jobNo}.pdf`;
    const directory = path.join(outputRoot, company);
    finalPath = path.join(directory, fileName);
    const pdf = await createPdf(data, submittedBy, signatures);

    await fs.mkdir(directory, { recursive: true });
    await client.query('BEGIN');
    await fs.writeFile(finalPath, pdf, { flag: 'wx' });
    fileWritten = true;
    const auditData = { ...data };
    delete auditData.customerSignature;
    delete auditData.servicemanSignature;
    await client.query(`
      INSERT INTO public.job_cards (id, company, file_name, submitted_by, customer, service_schedule_no, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [id, company, fileName, submittedBy, clean(data.customer, 200), clean(data.serviceScheduleNo, 100), JSON.stringify({ ...auditData, clientId })]);
    await client.query('COMMIT');
    send(res, 201, { ok: true, id, company, fileName, submittedBy });
  } catch (error) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    if (fileWritten && finalPath) { try { await fs.unlink(finalPath); } catch {} }
    const status = error.status || 500;
    console.error('Job card submission failed:', error.message);
    send(res, status, { error: status === 500 ? 'The job card could not be saved. Keep it on this device and try again.' : error.message });
  } finally {
    if (client) client.release();
  }
}

async function handleHistory(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token || token.length > 256) return send(res, 401, { error: 'Please sign in to view your job card history.' });
  try {
    const session = await pool.query(`
      SELECT a.name
        FROM public.staff_sessions s
        JOIN public.staff_accounts a ON a.name = s.staff_name
       WHERE s.token = $1 AND s.expires_at > NOW() AND a.active IS TRUE
       LIMIT 1`, [token]);
    if (!session.rowCount) return send(res, 401, { error: 'Your sign-in session expired.' });
    const result = await pool.query(`
      SELECT id, company, file_name AS "fileName", submitted_by AS "submittedBy",
             customer, service_schedule_no AS "serviceScheduleNo", submitted_at AS "submittedAt",
             details->>'clientId' AS "clientId"
        FROM public.job_cards j
       WHERE j.submitted_by = $1
       ORDER BY j.submitted_at DESC
       LIMIT 100`, [session.rows[0].name]);
    send(res, 200, { ok: true, records: result.rows });
  } catch (error) {
    console.error('Job card history failed:', error.message);
    send(res, 500, { error: 'Could not load job card history.' });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
  if (req.method === 'POST' && req.url === '/submit') return handleSubmit(req, res);
  if (req.method === 'GET' && req.url === '/history') return handleHistory(req, res);
  send(res, 404, { error: 'Not found' });
});

server.listen(3000, '0.0.0.0', () => console.log('Job card service listening on port 3000'));
process.on('SIGTERM', async () => { server.close(); await pool.end(); });

