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
    const doc = new PDFDocument({ size: 'A4', margin: 38, bufferPages: true, info: { Title: 'SINABO Generator Service Schedule', Author: signer } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const ink = '#20252d';
    const muted = '#68717d';
    const red = '#a71932';
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const checks = Array.isArray(data.checks) ? data.checks.slice(0, 16) : [];
    const readings = Array.isArray(data.readings) ? data.readings.slice(0, 20) : [];
    const runTests = Array.isArray(data.runTests) ? data.runTests.slice(0, 12) : [];
    const controlTests = Array.isArray(data.controlTests) ? data.controlTests.slice(0, 8) : [];
    const parts = Array.isArray(data.parts) ? data.parts.slice(0, 20) : [];
    const personnel = Array.isArray(data.personnel)
      ? [...new Set(data.personnel.map(name => clean(name, 120)).filter(Boolean))].slice(0, 20)
      : [];

    function heading(title) {
      if (doc.y > 730) doc.addPage();
      const left = doc.page.margins.left;
      doc.x = left;
      doc.moveDown(0.55).font('Helvetica-Bold').fontSize(10).fillColor(red);
      doc.text(title.toUpperCase(), left, doc.y, { width, align: 'center' });
      const ruleY = doc.y + 3;
      doc.moveTo(left, ruleY).lineTo(doc.page.width - doc.page.margins.right, ruleY).strokeColor(red).lineWidth(0.7).stroke();
      doc.y = ruleY + 3;
      doc.x = left;
      doc.moveDown(0.35).fillColor(ink);
    }

    function field(label, value, options = {}) {
      const colWidth = options.width || width;
      const x = options.x ?? doc.page.margins.left;
      const y = doc.y;
      const previousY = doc.y;
      doc.font('Helvetica').fontSize(7).fillColor(muted).text(label, x, y, { width: colWidth, align: 'center' });
      const labelHeight = doc.heightOfString(label, { width: colWidth, font: 'Helvetica', fontSize: 7 });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text(clean(value, 1000) || '—', x, y + labelHeight + 2, { width: colWidth, align: 'center' });
      const height = Math.max(labelHeight + 14, doc.heightOfString(clean(value, 1000) || '—', { width: colWidth, font: 'Helvetica-Bold', fontSize: 9 }) + labelHeight + 5);
      doc.y = previousY;
      return height;
    }

    function grid(items, columns = 2) {
      const gap = 16;
      const colWidth = (width - gap * (columns - 1)) / columns;
      let maxHeight = 0;
      items.forEach((item, index) => {
        const col = index % columns;
        if (col === 0 && index > 0) doc.y += maxHeight + 8;
        const h = field(item[0], item[1], { x: doc.page.margins.left + col * (colWidth + gap), width: colWidth });
        maxHeight = col === 0 ? h : Math.max(maxHeight, h);
      });
      if (items.length) doc.y += maxHeight + 8;
    }

    function listRows(rows, cols) {
      if (doc.y > 735) doc.addPage();
      const widths = cols.map(v => width * v);
      const top = doc.y;
      doc.font('Helvetica-Bold').fontSize(7).fillColor(muted);
      let x = doc.page.margins.left;
      cols.forEach((fraction, i) => { doc.text(['Item', 'Result / Value', 'Notes'][i] || '', x + 4, top, { width: widths[i] - 8, align: 'center' }); x += widths[i]; });
      doc.moveTo(doc.page.margins.left, top + 12).lineTo(doc.page.margins.left + width, top + 12).strokeColor('#c8cdd4').stroke();
      let y = top + 15;
      rows.forEach(row => {
        const values = row.map(v => clean(v, 300) || '—');
        const rowHeight = Math.max(18, ...values.map((value, i) => doc.heightOfString(value, { width: widths[i] - 8, font: 'Helvetica', fontSize: 7 })));
        if (y + rowHeight > doc.page.height - doc.page.margins.bottom) { doc.addPage(); y = doc.page.margins.top; }
        let cx = doc.page.margins.left;
        doc.font('Helvetica').fontSize(7).fillColor(ink);
        values.forEach((value, i) => { doc.text(value, cx + 4, y, { width: widths[i] - 8 }); cx += widths[i]; });
        y += rowHeight + 2;
      });
      doc.y = y + 2;
    }

    const logoWidth = 190;
    const logoHeight = logoWidth * 120 / 326;
    const logoX = (doc.page.width - logoWidth) / 2;
    const logoY = doc.page.margins.top;
    doc.image(path.join(__dirname, 'assets', 'sinabo-logo.png'), logoX, logoY, { width: logoWidth });
    doc.x = doc.page.margins.left;
    doc.y = logoY + logoHeight + 7;
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(12)
      .text('SERVICE SCHEDULE', doc.page.margins.left, doc.y, { width, align: 'center' });
    doc.x = doc.page.margins.left;
    doc.moveDown(0.5);
    grid([
      ['Service Schedule No.', data.serviceScheduleNo], ['Date', data.date],
      ['Job No.', data.jobNo || data.unitRef], ['Customer', data.customer],
      ['Order number', data.orderNo], ['Site', data.site],
      ['Hour metre', data.hourMetre], ['Engine type', data.engineType],
      ['Alternator type', data.alternatorType]
    ]);

    heading('Personnel on site');
    doc.font('Helvetica').fontSize(9).fillColor(ink)
      .text(personnel.length ? personnel.map((name, index) => `${index + 1}. ${name}`).join('\n') : 'None recorded', { width });
    doc.moveDown(0.5);

    heading('Checks - mark each item normal or abnormal');
    listRows(checks.map(row => [row.label, row.result, row.notes]), [0.44, 0.20, 0.36]);

    heading('Alternator and generator readings');
    listRows(readings.map(row => [row.label, row.value, row.notes]), [0.48, 0.20, 0.32]);

    heading('Run engine and control panel tests');
    listRows([...runTests, ...controlTests].map(row => [row.label, row.unit ? `${row.result || '—'} ${row.unit}` : row.result, row.notes]), [0.50, 0.18, 0.32]);

    heading('Parts / consumables supplied');
    listRows(parts.map(row => [row.item, row.quantity, row.notes]), [0.58, 0.16, 0.26]);
    grid([['Travel time', data.travelTime], ['Time on site', data.timeOnSite], ['Kilometres', data.kilometres], ['Remarks', data.remarks]], 2);

    if (doc.y > 625) doc.addPage();
    heading('Acknowledgement and signatures');
    grid([['Customer representative name (print)', data.customerRepName], ['Serviceman name (print)', signer]], 2);
    const sigY = doc.y + 4;
    const sigWidth = (width - 18) / 2;
    doc.image(signatures.customer, doc.page.margins.left, sigY, { fit: [sigWidth, 72], align: 'center', valign: 'center' });
    doc.image(signatures.serviceman, doc.page.margins.left + sigWidth + 18, sigY, { fit: [sigWidth, 72], align: 'center', valign: 'center' });
    doc.moveTo(doc.page.margins.left, sigY + 78).lineTo(doc.page.margins.left + sigWidth, sigY + 78).strokeColor('#aeb5bf').stroke();
    doc.moveTo(doc.page.margins.left + sigWidth + 18, sigY + 78).lineTo(doc.page.margins.left + width, sigY + 78).strokeColor('#aeb5bf').stroke();
    doc.font('Helvetica').fontSize(8).fillColor(muted).text('Customer representative signature', doc.page.margins.left, sigY + 82, { width: sigWidth, align: 'center' });
    doc.text('Serviceman signature', doc.page.margins.left + sigWidth + 18, sigY + 82, { width: sigWidth, align: 'center' });
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
    if (company !== 'SINABO') return send(res, 400, { error: 'That job card template is not available yet.' });
    if (!clean(data.customer) || !clean(data.site) || !clean(data.serviceScheduleNo) || !clean(data.jobNo || data.unitRef)) return send(res, 400, { error: 'Complete the customer, site, service schedule number and Job No.' });
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
    if (previous.rowCount) return send(res, 200, { ok: true, id, ...previous.rows[0], alreadySubmitted: true });
    const jobNo = clean(data.jobNo || data.unitRef, 80).replace(/[^A-Za-z0-9_-]/g, '_');
    const fileName = `SINABO_${jobNo}.pdf`;
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
