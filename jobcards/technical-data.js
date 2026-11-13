'use strict';

const fs = require('node:fs/promises');
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = require('node:fs').constants;
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

function technicalDataHandler(outputRoot, pool, send) {
  const invalidName = name => !name || name.startsWith('.') || /[\\:\x00-\x1f\x7f]/.test(name);

  return async function handleTechnicalData(req, res, url) {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token || token.length > 256) return send(res, 401, { error: 'Sign in to access Technical Data.' });

    const download = url.pathname === '/technical-data/download';
    const requestedPath = url.searchParams.get('path') || '';
    const parts = requestedPath ? requestedPath.split('/') : [];
    if ((download && !parts.length) || parts.some(invalidName)) {
      return send(res, 400, { error: 'Invalid library path.' });
    }

    try {
      const session = await pool.query(`
        SELECT 1
          FROM public.staff_sessions s
          JOIN public.staff_accounts a ON a.name = s.staff_name
         WHERE s.token = $1 AND s.expires_at > NOW() AND a.active IS TRUE
         LIMIT 1`, [token]);
      if (!session.rowCount) return send(res, 401, { error: 'Your sign-in session expired.' });

      // The library must be a real directory under the mounted share.
      const root = await fs.realpath(outputRoot);
      const resolvedLibrary = path.join(root, 'Technical Data');
      const libraryStat = await fs.lstat(resolvedLibrary).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!libraryStat?.isDirectory()) {
        if (!download && !parts.length) return send(res, 200, { entries: [] });
        return send(res, 404, { error: 'This library item could not be found.' });
      }

      const target = path.join(resolvedLibrary, ...parts);
      if (await fs.realpath(target) !== target) {
        return send(res, 404, { error: 'This library item could not be found.' });
      }

      if (!download) {
        const entries = (await fs.readdir(target, { withFileTypes: true }))
          .filter(entry => !invalidName(entry.name) && (entry.isDirectory() || entry.isFile()))
          .map(entry => ({ name: entry.name, directory: entry.isDirectory() }))
          .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
        return send(res, 200, { entries });
      }

      const file = await fs.open(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) return send(res, 404, { error: 'This library file could not be found.' });
        const name = encodeURIComponent(parts.at(-1)).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': "attachment; filename*=UTF-8''" + name,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        await pipeline(file.createReadStream({ autoClose: false }), res);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR'].includes(error.code)) {
        return send(res, 404, { error: 'This library item could not be found.' });
      }
      console.error('Technical Data request failed:', error.code || error.message);
      send(res, 500, { error: 'Could not access the Technical Data library.' });
    }
  };
}

module.exports = technicalDataHandler;
