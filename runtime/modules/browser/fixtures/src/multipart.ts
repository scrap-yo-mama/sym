// SPDX-License-Identifier: AGPL-3.0-only
// Lecture multipart/form-data (RFC 7578) en mémoire, pour la route /upload du site de test.
export interface Part {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export function boundaryOf(contentType: string | undefined): string | undefined {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  return match?.[1] ?? match?.[2]?.trim();
}

export function parseMultipart(body: Buffer, boundary: string): Part[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let cursor = body.indexOf(delimiter);
  while (cursor !== -1) {
    const start = cursor + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    // Contenu entre « \r\n » après le délimiteur et « \r\n » avant le suivant.
    const chunk = body.subarray(start + 2, next - 2);
    const split = chunk.indexOf('\r\n\r\n');
    if (split !== -1) {
      const headers = chunk.subarray(0, split).toString('utf8');
      const disposition = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? '';
      const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
      const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
      const contentType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
      if (name !== undefined) {
        const part: Part = { name, data: Buffer.from(chunk.subarray(split + 4)) };
        if (filename !== undefined) part.filename = filename;
        if (contentType !== undefined) part.contentType = contentType;
        parts.push(part);
      }
    }
    cursor = next;
  }
  return parts;
}
