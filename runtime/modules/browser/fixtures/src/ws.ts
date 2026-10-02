// SPDX-License-Identifier: AGPL-3.0-only
// WebSocket minimal côté serveur (RFC 6455) sans dépendance : poignée de main, trames texte/binaires fragmentées, ping/pong,
// fermeture. Sert la route /ws du site de test (écho). Sources : RFC 6455 §4.2.2, §5.2, §5.5.
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024 * 1024;

export interface WsConnection {
  sendText(text: string): void;
  close(code?: number): void;
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const buf = Buffer.alloc(10);
            buf[0] = 0x80 | opcode;
            buf[1] = 127;
            buf.writeBigUInt64BE(BigInt(length), 2);
            return buf;
          })();
  return Buffer.concat([head, payload]);
}

export function acceptWebSocket(req: IncomingMessage, socket: Duplex, onOpen: (conn: WsConnection, onMessage: (cb: (text: string) => void) => void) => void): void {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

  let handler: (text: string) => void = () => {};
  let closed = false;
  const conn: WsConnection = {
    sendText: (text) => {
      if (!closed) socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
    },
    close: (code = 1000) => {
      if (closed) return;
      closed = true;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code);
      socket.end(encodeFrame(0x8, payload));
    },
  };

  let buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentsSize = 0;
  const consume = (): void => {
    for (;;) {
      if (buffer.length < 2) return;
      const b0 = buffer[0] ?? 0;
      const b1 = buffer[1] ?? 0;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > MAX_MESSAGE) return conn.close(1009);
      const total = offset + (masked ? 4 : 0) + length;
      if (buffer.length < total) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
      const body = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total));
      buffer = buffer.subarray(total);
      if (mask) for (let i = 0; i < body.length; i += 1) body[i] = (body[i] ?? 0) ^ (mask[i % 4] ?? 0);
      if (opcode === 0x8) return conn.close(1000);
      if (opcode === 0x9) socket.write(encodeFrame(0xa, body));
      else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        fragments.push(body);
        fragmentsSize += body.length;
        if (fragmentsSize > MAX_MESSAGE) return conn.close(1009);
        if (fin) {
          const message = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          fragmentsSize = 0;
          handler(message);
        }
      }
    }
  };
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    consume();
  });
  // Le pair a fermé sa moitié (FIN sans trame de fermeture : tunnel coupé, onglet fermé) : le serveur HTTP garde les sockets
  // surclassés en allowHalfOpen, on ferme donc la nôtre (sinon server.close() attendrait sans fin).
  socket.on('end', () => {
    closed = true;
    socket.end();
  });
  socket.on('close', () => {
    closed = true;
  });
  socket.on('error', () => socket.destroy());
  onOpen(conn, (cb) => {
    handler = cb;
  });
}
