// SPDX-License-Identifier: AGPL-3.0-only
// Texte d'une page HTML avant d'entrer dans un prompt (tâche 2.4 ; 08 §4 mesures 1 et 5). Seul le texte RENDU visible
// passe : ni script, ni style, ni commentaire, ni attribut (`alt`, `title`, `href` et leurs jetons d'URL), ni élément
// caché (`hidden`, `aria-hidden`, `display:none`, `visibility:hidden` en ligne), ni formulaire (`form`, champs). Ce
// filtrage réduit la surface d'injection ; il ne la supprime pas : le texte reste une DONNÉE NON FIABLE, encadrée comme
// telle par l'appelant. Analyse sans exécution (htmlparser2), bornée en caractères.
import { Parser } from 'htmlparser2';

/** Éléments dont tout le contenu est ignoré. */
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'form', 'select', 'textarea', 'button', 'dialog']);
/** Éléments qui coupent la ligne. */
const BLOCK = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'pre', 'blockquote', 'figure', 'figcaption', 'address', 'details', 'summary', 'caption',
]);
const CELL = new Set(['td', 'th']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function hiddenByAttributes(attrs: Record<string, string>): boolean {
  if ('hidden' in attrs) return true;
  if ((attrs['aria-hidden'] ?? '').toLowerCase() === 'true') return true;
  const style = (attrs['style'] ?? '').toLowerCase().replace(/\s+/g, '');
  return /(^|;)(display:none|visibility:hidden|visibility:collapse|font-size:0(px|em|rem)?|opacity:0(\.0+)?)(;|!|$)/.test(style);
}

export type PageText = { readonly text: string; readonly truncated: boolean };

/** Texte visible d'un document HTML, lignes normalisées, borné à `maxChars` caractères. */
export function htmlToVisibleText(html: string, maxChars: number): PageText {
  const out: string[] = [];
  let size = 0;
  let truncated = false;
  /** Profondeur d'un élément ignoré en cours (0 : rien d'ignoré). */
  let skipDepth = 0;
  const push = (s: string) => {
    if (truncated) return;
    if (size + s.length > maxChars) {
      out.push(s.slice(0, Math.max(0, maxChars - size)));
      truncated = true;
      size = maxChars;
      return;
    }
    out.push(s);
    size += s.length;
  };
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (skipDepth > 0) {
          if (!VOID.has(name)) skipDepth += 1;
          return;
        }
        if (SKIPPED.has(name) || hiddenByAttributes(attrs)) {
          if (!VOID.has(name)) skipDepth = 1;
          return;
        }
        if (BLOCK.has(name)) push('\n');
        else if (CELL.has(name)) push(' | ');
      },
      ontext(text) {
        if (skipDepth === 0) push(text);
      },
      onclosetag(name, implied) {
        if (skipDepth > 0) {
          if (!VOID.has(name)) skipDepth -= 1;
          return;
        }
        if (BLOCK.has(name) && !(implied && VOID.has(name))) push('\n');
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  const text = out
    .join('')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0\u202f]+/g, ' ').trim())
    .filter((l) => l !== '' && l !== '|')
    .join('\n');
  return { text, truncated };
}
