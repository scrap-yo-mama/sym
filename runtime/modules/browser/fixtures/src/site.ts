// SPDX-License-Identifier: AGPL-3.0-only
// Site de test de SYM Browser (tâche 0.5) : pages statiques, SPA, connexion, téléchargement, envoi, WebSocket, page lourde.
// Sans dépendance (node:http). Chaque requête est journalisée avec l'IP source vue par le serveur (/__ips) ; /__ip la renvoie.
// Imite les fixtures de SYM (runtime/fixtures) sans les importer. Hôte attendu : fixtures.local (n'importe quel Host est servi).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DOWNLOAD_BYTES, HEAVY_BYTES, LOGIN } from './config.ts';
import { createJournal, normalizeIp, type Journal } from './journal.ts';
import { boundaryOf, parseMultipart } from './multipart.ts';
import { acceptWebSocket } from './ws.ts';

interface SeenRequest {
  at: string;
  ip: string;
  method: string;
  path: string;
  host: string;
}

export interface SiteHandle {
  port: number;
  journal: Journal<SeenRequest>;
  close(): Promise<void>;
}

const MAX_UPLOAD = 32 * 1024 * 1024;
const MAX_HEAVY = 64 * 1024 * 1024;
const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function page(title: string, body: string, head = ''): string {
  return `<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>\n`;
}

/** Octets déterministes : blocs sha256 d'un compteur. */
function deterministicBytes(length: number): Buffer {
  const blocks: Buffer[] = [];
  for (let i = 0; blocks.length * 32 < length; i += 1) blocks.push(createHash('sha256').update(`sym-browser-fixture:${i}`).digest());
  return Buffer.concat(blocks).subarray(0, length);
}

const SAMPLE_BIN = deterministicBytes(DOWNLOAD_BYTES);
const SAMPLE_TXT = Buffer.from('Fichier de test SYM Browser.\nLigne 2.\n');
const DOWNLOADS: Record<string, { data: Buffer; type: string }> = {
  'sample.bin': { data: SAMPLE_BIN, type: 'application/octet-stream' },
  'sample.txt': { data: SAMPLE_TXT, type: 'text/plain; charset=utf-8' },
};

const SPA_SHELL = page(
  'SYM SPA fixture',
  `<nav><a href="/spa/" data-link>Accueil</a> <a href="/spa/items/1" data-link>Article 1</a></nav><main id="app">Chargement…</main>
<script>
const app = document.getElementById('app');
async function render() {
  const match = /^\\/spa\\/items\\/(\\d+)/.exec(location.pathname);
  if (match) {
    const items = await (await fetch('/spa/api/items')).json();
    const item = items.find((i) => String(i.id) === match[1]);
    app.innerHTML = item ? '<h1 id="item-title">' + item.title + '</h1>' : '<h1>Introuvable</h1>';
  } else {
    const items = await (await fetch('/spa/api/items')).json();
    app.innerHTML = '<h1>Articles</h1><ul>' + items.map((i) => '<li><a href="/spa/items/' + i.id + '" data-link>' + i.title + '</a></li>').join('') + '</ul>';
  }
}
document.addEventListener('click', (event) => {
  const link = event.target.closest && event.target.closest('a[data-link]');
  if (!link) return;
  event.preventDefault();
  history.pushState({}, '', link.getAttribute('href'));
  render();
});
addEventListener('popstate', render);
render();
</script>`,
);

const SPA_ITEMS = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `Article ${i + 1}` }));

const WS_PAGE = page(
  'SYM WebSocket fixture',
  `<h1>WebSocket</h1><ul id="log"></ul><button id="send">Envoyer</button>
<script>
const log = document.getElementById('log');
const socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
socket.onmessage = (event) => { const li = document.createElement('li'); li.textContent = event.data; log.appendChild(li); };
document.getElementById('send').onclick = () => socket.send('clic');
</script>`,
);

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
const html = (res: ServerResponse, status: number, body: string, extra: Record<string, string | string[]> = {}): void => send(res, status, 'text/html; charset=utf-8', body, extra);
const json = (res: ServerResponse, value: unknown): void => send(res, 200, 'application/json', JSON.stringify(value));

export interface SiteOptions {
  port?: number;
  host?: string;
  onRequest?: (entry: SeenRequest) => void;
}

export async function startSite(options: SiteOptions = {}): Promise<SiteHandle> {
  const journal = createJournal<SeenRequest>(10_000, options.onRequest);
  const sessions = new Map<string, string>();
  const uploads = new Map<string, { name: string; bytes: number; sha256: string; note: string; data: Buffer }>();
  let lastUpload: string | undefined;

  const record = (req: IncomingMessage, path: string): void => {
    if (path === '/__ips' || path === '/__reset') return;
    journal.add({ at: new Date().toISOString(), ip: normalizeIp(req.socket.remoteAddress), method: req.method ?? 'GET', path, host: req.headers.host ?? '' });
  };

  const sessionUser = (req: IncomingMessage): string | undefined => {
    const cookie = /(?:^|;\s*)zz_test_session=([0-9a-f]{32})/.exec(req.headers.cookie ?? '')?.[1];
    return cookie === undefined ? undefined : sessions.get(cookie);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fixtures.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    record(req, path);

    if (path === '/__ip') return json(res, { ip: normalizeIp(req.socket.remoteAddress) });
    if (path === '/__ips') return json(res, journal.entries());
    if (path === '/__reset' && method === 'POST') {
      journal.reset();
      uploads.clear();
      lastUpload = undefined;
      return json(res, { ok: true });
    }
    if (path === '/health') return json(res, { ok: true });

    if (path === '/') {
      return html(
        res,
        200,
        page(
          'SYM Browser fixtures',
          `<h1>SYM Browser fixtures</h1><ul>${['/static/about.html', '/spa/', '/login', '/download/sample.bin', '/upload', '/ws-page', '/heavy'].map((p) => `<li><a href="${p}">${p}</a></li>`).join('')}</ul>`,
          '<link rel="stylesheet" href="/static/style.css">',
        ),
      );
    }
    if (path === '/robots.txt') return send(res, 200, 'text/plain; charset=utf-8', 'User-agent: *\nDisallow:\n');
    if (path === '/static/style.css') return send(res, 200, 'text/css; charset=utf-8', 'body{font-family:sans-serif;margin:2rem}\n');
    if (path === '/static/about.html') return html(res, 200, page('À propos', '<h1>À propos</h1><p>Page statique de la fixture.</p><a href="/">Accueil</a>'));

    if (path === '/spa/api/items') return json(res, SPA_ITEMS);
    if (path === '/spa' || path.startsWith('/spa/')) return html(res, 200, SPA_SHELL);

    if (path === '/login' && method === 'GET') {
      return html(
        res,
        200,
        page(
          'Connexion',
          '<h1>Connexion</h1><form method="post" action="/login"><label>Utilisateur <input name="username" autocomplete="username"></label><label>Mot de passe <input name="password" type="password" autocomplete="current-password"></label><button type="submit">Se connecter</button></form>',
        ),
      );
    }
    if (path === '/login' && method === 'POST') {
      const form = new URLSearchParams((await readBody(req, 64 * 1024)).toString('utf8'));
      const ok = equalsConstantTime(form.get('username') ?? '', LOGIN.username) && equalsConstantTime(form.get('password') ?? '', LOGIN.password);
      if (!ok) return html(res, 401, page('Connexion', '<h1>Connexion</h1><p role="alert">Identifiants invalides</p>'));
      const token = randomBytes(16).toString('hex');
      sessions.set(token, LOGIN.username);
      return send(res, 303, 'text/plain', '', { location: '/account', 'set-cookie': `zz_test_session=${token}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (path === '/account') {
      const user = sessionUser(req);
      if (user === undefined) return send(res, 302, 'text/plain', '', { location: '/login' });
      return html(res, 200, page('Compte', `<h1>Compte</h1><p id="who">Connecté : ${esc(user)}</p><a href="/logout">Déconnexion</a>`));
    }
    if (path === '/logout') {
      const token = /(?:^|;\s*)zz_test_session=([0-9a-f]{32})/.exec(req.headers.cookie ?? '')?.[1];
      if (token !== undefined) sessions.delete(token);
      return send(res, 302, 'text/plain', '', { location: '/login', 'set-cookie': 'zz_test_session=; Path=/; Max-Age=0; HttpOnly' });
    }

    if (path === '/download/manifest.json') {
      return json(res, Object.fromEntries(Object.entries(DOWNLOADS).map(([name, file]) => [name, { bytes: file.data.length, sha256: sha256(file.data) }])));
    }
    if (path.startsWith('/download/')) {
      const file = DOWNLOADS[path.slice('/download/'.length)];
      if (!file) return send(res, 404, 'text/plain', 'not found');
      return send(res, 200, file.type, file.data, { 'content-disposition': `attachment; filename="${path.slice('/download/'.length)}"`, 'x-content-sha256': sha256(file.data) });
    }

    if (path === '/upload' && method === 'GET') {
      return html(
        res,
        200,
        page('Envoi', '<h1>Envoi</h1><form method="post" action="/upload" enctype="multipart/form-data"><input name="note" type="text"><input name="file" type="file"><button type="submit">Envoyer</button></form>'),
      );
    }
    if (path === '/upload' && method === 'POST') {
      const boundary = boundaryOf(req.headers['content-type']);
      if (boundary === undefined) return send(res, 400, 'text/plain', 'multipart/form-data attendu');
      const parts = parseMultipart(await readBody(req, MAX_UPLOAD), boundary);
      const file = parts.find((p) => p.filename !== undefined && p.name === 'file');
      if (!file) return send(res, 400, 'text/plain', 'champ file manquant');
      const name = (file.filename ?? 'upload.bin').replace(/[^A-Za-z0-9._-]/g, '_');
      const note = parts.find((p) => p.name === 'note')?.data.toString('utf8') ?? '';
      const entry = { name, bytes: file.data.length, sha256: sha256(file.data), note, data: file.data };
      uploads.set(name, entry);
      lastUpload = name;
      return html(res, 200, page('Envoi reçu', `<h1>Envoi reçu</h1><dl><dt>Nom</dt><dd id="name">${esc(name)}</dd><dt>Octets</dt><dd id="bytes">${entry.bytes}</dd><dt>SHA-256</dt><dd id="sha256">${entry.sha256}</dd></dl><a href="/upload/files/${encodeURIComponent(name)}">Relire</a>`));
    }
    if (path === '/upload/last') {
      const entry = lastUpload === undefined ? undefined : uploads.get(lastUpload);
      if (!entry) return send(res, 404, 'application/json', '{"error":"none"}');
      return json(res, { name: entry.name, bytes: entry.bytes, sha256: entry.sha256, note: entry.note });
    }
    if (path.startsWith('/upload/files/')) {
      const entry = uploads.get(decodeURIComponent(path.slice('/upload/files/'.length)));
      if (!entry) return send(res, 404, 'text/plain', 'not found');
      return send(res, 200, 'application/octet-stream', entry.data);
    }

    if (path === '/ws-page') return html(res, 200, WS_PAGE);

    if (path === '/heavy') {
      return html(res, 200, page('Page lourde', '<h1>Page lourde</h1><p>Charge 5 Mo.</p><script src="/heavy/payload.js"></script>'), { 'cache-control': 'no-store' });
    }
    if (path === '/heavy/payload.js') {
      const requested = Number(url.searchParams.get('bytes') ?? HEAVY_BYTES);
      const bytes = Number.isInteger(requested) && requested >= 0 && requested <= MAX_HEAVY ? requested : HEAVY_BYTES;
      const body = Buffer.alloc(bytes, 0x61);
      if (bytes >= 4) {
        body.write('/*', 0);
        body.write('*/', bytes - 2);
      }
      return send(res, 200, 'text/javascript; charset=utf-8', body, { 'cache-control': 'no-store' });
    }

    return send(res, 404, 'text/plain', 'not found');
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, 'text/plain', error instanceof Error ? error.message : 'error');
      else res.destroy();
    });
  });
  server.on('upgrade', (req, socket) => {
    const path = new URL(req.url ?? '/', 'http://fixtures.local').pathname;
    record(req, path);
    if (path !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    acceptWebSocket(req, socket, (conn, onMessage) => {
      conn.sendText('hello');
      onMessage((text) => conn.sendText(`echo:${text}`));
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '0.0.0.0', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    journal,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
