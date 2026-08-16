import { getDocumentProxy } from 'unpdf';

/**
 * Bounded in-memory PDF text extraction (spec rules 4–7, D8).
 *
 * - Pinned parser: unpdf (exact version in package.json), which wraps
 *   pdfjs-dist; pure in-memory, no files, no network.
 * - Signature check (`%PDF-`) runs before the parser sees the bytes.
 * - Bounds are enforced DURING extraction, not after: the page cap is
 *   checked right after the document proxy loads (before any page is
 *   parsed) and the character cap aborts accumulation as pages are read,
 *   so a crafted many-page / highly compressed PDF within the download
 *   cap is rejected early instead of being fully extracted first.
 * - Rejections are typed reasons; callers map them to safe user messages.
 */
export type PdfRejectionReason = 'not_pdf' | 'encrypted' | 'malformed' | 'no_text' | 'too_many_pages' | 'overlong' | 'timeout';
export type PdfExtraction = { ok: true; text: string; pageCount: number } | { ok: false; reason: PdfRejectionReason };

export type PdfTextEngine = (bytes: Uint8Array, options: { signal?: AbortSignal; maxPages: number; maxChars: number }) => Promise<PdfExtraction>;

const PDF_SIGNATURE = '%PDF-';

export function isPdfSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  return new TextDecoder().decode(bytes.subarray(0, 5)) === PDF_SIGNATURE;
}

type UnpdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/** Per-page text, byte-identical to unpdf's internal getPageText. */
async function pageTextOf(document: UnpdfDocument, pageNumber: number): Promise<string> {
  const content = await (await document.getPage(pageNumber)).getTextContent();
  return content.items.filter((item) => item.str != null).map((item) => item.str + (item.hasEOL ? '\n' : '')).join('');
}

/** Page join identical to unpdf's mergePages:true (normalizeMergedText). */
function mergePageTexts(texts: readonly string[]): string {
  return texts.join('\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/** Real unpdf-backed engine; injectable for tests (no network, fixture-driven). */
export const unpdfEngine: PdfTextEngine = async (bytes, { signal, maxPages, maxChars }) => {
  const document = await getDocumentProxy(bytes, { signal });
  const pageCount = document.numPages;
  // Page cap is known before any page is parsed — reject before extracting.
  if (pageCount > maxPages) return { ok: false, reason: 'too_many_pages' };
  const pageTexts: string[] = [];
  let length = 0;
  for (let page = 1; page <= pageCount; page += 1) {
    if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const pageText = await pageTextOf(document, page);
    length += pageText.length;
    // Char cap accumulates as pages are read — a huge payload is rejected
    // mid-extraction instead of being parsed in full first. The raw length
    // bound is intentionally stricter than the trimmed/merged text length.
    if (length > maxChars) return { ok: false, reason: 'overlong' };
    pageTexts.push(pageText);
  }
  const text = mergePageTexts(pageTexts).trim();
  if (text.length === 0) return { ok: false, reason: 'no_text' };
  return { ok: true, text, pageCount };
};

export function extractPdfText(
  bytes: Uint8Array,
  options: { maxPages?: number; maxChars?: number; deadlineMs?: number; engine?: PdfTextEngine } = {},
): Promise<PdfExtraction> {
  const maxPages = options.maxPages ?? 50;
  const maxChars = options.maxChars ?? 200_000;
  const deadlineMs = options.deadlineMs ?? 10_000;
  const engine = options.engine ?? unpdfEngine;
  if (!isPdfSignature(bytes)) return Promise.resolve({ ok: false, reason: 'not_pdf' });
  const run = async (signal: AbortSignal): Promise<PdfExtraction> => {
    try {
      const result = await engine(bytes, { signal, maxPages, maxChars });
      if (!result.ok) return result;
      // Belt-and-braces for custom engines; the real engine enforces both
      // bounds during extraction.
      if (result.pageCount > maxPages) return { ok: false, reason: 'too_many_pages' };
      if (result.text.length > maxChars) return { ok: false, reason: 'overlong' };
      return result;
    } catch (error) {
      if (signal.aborted) return { ok: false, reason: 'timeout' };
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : '';
      if (/password/i.test(name) || /password/i.test(message)) return { ok: false, reason: 'encrypted' };
      return { ok: false, reason: 'malformed' };
    }
  };
  if (deadlineMs <= 0) return run(new AbortController().signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const race = Promise.race([
    run(controller.signal),
    new Promise<{ ok: false; reason: 'timeout' }>((resolve) => { controller.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'timeout' }), { once: true }); }),
  ]);
  return race.finally(() => clearTimeout(timer));
}
