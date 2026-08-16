import { extractText, getDocumentProxy } from 'unpdf';

/**
 * Bounded in-memory PDF text extraction (spec rules 4–7, D8).
 *
 * - Pinned parser: unpdf (exact version in package.json), which wraps
 *   pdfjs-dist; pure in-memory, no files, no network.
 * - Signature check (`%PDF-`) runs before the parser sees the bytes.
 * - Bounds: maxPages (default 50), maxChars of extracted text (default
 *   200,000), deadlineMs (default 10_000) enforced via abort + race.
 * - Rejections are typed reasons; callers map them to safe user messages.
 */
export type PdfRejectionReason = 'not_pdf' | 'encrypted' | 'malformed' | 'no_text' | 'too_many_pages' | 'overlong' | 'timeout';
export type PdfExtraction = { ok: true; text: string; pageCount: number } | { ok: false; reason: PdfRejectionReason };

export type PdfTextEngine = (bytes: Uint8Array, signal?: AbortSignal) => Promise<PdfExtraction>;

const PDF_SIGNATURE = '%PDF-';

export function isPdfSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 5) return false;
  return new TextDecoder().decode(bytes.subarray(0, 5)) === PDF_SIGNATURE;
}

/** Real unpdf-backed engine; injectable for tests (no network, fixture-driven). */
export const unpdfEngine: PdfTextEngine = async (bytes, signal) => {
  const document = await getDocumentProxy(bytes, { signal });
  const pageCount = document.numPages;
  const extracted = await extractText(document, { mergePages: true, signal });
  const text = (extracted.text ?? '').trim();
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
      const result = await engine(bytes, signal);
      if (!result.ok) return result;
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
