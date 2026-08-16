import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText, isPdfSignature } from '../src/integrations/pdf-text.ts';
import { makePdf, textPdf } from './helpers/pdf-fixtures.ts';

test('pdf signature check accepts %PDF- and rejects everything else', () => {
  assert.equal(isPdfSignature(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), true);
  assert.equal(isPdfSignature(new Uint8Array([0x25, 0x50, 0x44, 0x46])), false);
  assert.equal(isPdfSignature(new TextEncoder().encode('%PDF-1.7')), true);
  assert.equal(isPdfSignature(new TextEncoder().encode('not a pdf at all')), false);
  assert.equal(isPdfSignature(new Uint8Array(0)), false);
});

test('bounded valid PDF extraction returns text and page count', async () => {
  const result = await extractPdfText(textPdf('Senior backend engineer with Python experience'));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.pageCount, 1);
    assert.match(result.text, /Senior backend engineer/);
  }
  const multi = await extractPdfText(makePdf(['Page one content', 'Page two content']));
  assert.equal(multi.ok, true);
  if (multi.ok) {
    assert.equal(multi.pageCount, 2);
    assert.match(multi.text, /Page one content/);
    assert.match(multi.text, /Page two content/);
  }
});

test('non-PDF bytes are rejected before the parser', async () => {
  const result = await extractPdfText(new TextEncoder().encode('PK\x03\x04 not a pdf'));
  assert.deepEqual(result, { ok: false, reason: 'not_pdf' });
});

test('encrypted PDFs are rejected with a safe reason', async () => {
  const result = await extractPdfText(makePdf(['secret'], { encrypt: true }));
  assert.deepEqual(result, { ok: false, reason: 'encrypted' });
});

test('malformed PDFs are rejected with a safe reason', async () => {
  const result = await extractPdfText(new TextEncoder().encode('%PDF-1.4\n%%EOF broken garbage without xref'));
  assert.deepEqual(result, { ok: false, reason: 'malformed' });
});

test('empty and image-only PDFs are rejected as no_text', async () => {
  const empty = await extractPdfText(makePdf(['']));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, 'no_text');
  const noContent = await extractPdfText(makePdf(['']));
  assert.equal(noContent.ok, false);
});

test('page cap rejects overlong documents', async () => {
  const real = await extractPdfText(makePdf(Array.from({ length: 60 }, (_, index) => `Page ${index} content`)));
  assert.deepEqual(real, { ok: false, reason: 'too_many_pages' });
  const faked: Parameters<typeof extractPdfText>[1]['engine'] = async () => ({ ok: true, text: 'x', pageCount: 51 });
  const viaEngine = await extractPdfText(new TextEncoder().encode('%PDF-1.4'), { engine: faked });
  assert.deepEqual(viaEngine, { ok: false, reason: 'too_many_pages' });
});

test('engine enforces the page cap before parsing any page', async () => {
  let parsed = 0;
  const spy: Parameters<typeof extractPdfText>[1]['engine'] = async (bytes, { maxPages }) => {
    parsed += 1;
    if (parsed > maxPages) throw new Error('parser never reached this page');
    return { ok: false, reason: 'malformed' };
  };
  const result = await extractPdfText(new TextEncoder().encode('%PDF-1.4'), { engine: spy, maxPages: 3 });
  assert.equal(result.ok, false);
  assert.equal(parsed, 1, 'engine must not iterate pages past the cap');
});

test('engine enforces the char cap as text accumulates, mid-extraction', async () => {
  const pages: string[] = [];
  const spied: Parameters<typeof extractPdfText>[1]['engine'] = async (bytes, { maxPages, maxChars }) => {
    const parsed: string[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      parsed.push('y'.repeat(Math.floor(maxChars / 2)));
      if (parsed.join('\n').length > maxChars) break;
    }
    pages.push(...parsed);
    return { ok: false, reason: 'no_text' };
  };
  await extractPdfText(new TextEncoder().encode('%PDF-1.4'), { engine: spied, maxPages: 10, maxChars: 1_000 });
  assert.ok(pages.length < 10, 'engine must stop accumulating once the char cap is exceeded');
});

test('extracted character cap rejects overlong text', async () => {
  const overlong: Parameters<typeof extractPdfText>[1]['engine'] = async () => ({ ok: true, text: 'x'.repeat(200_001), pageCount: 1 });
  const result = await extractPdfText(new TextEncoder().encode('%PDF-1.4'), { engine: overlong });
  assert.deepEqual(result, { ok: false, reason: 'overlong' });
  const boundary: Parameters<typeof extractPdfText>[1]['engine'] = async () => ({ ok: true, text: 'x'.repeat(200_000), pageCount: 1 });
  const ok = await extractPdfText(new TextEncoder().encode('%PDF-1.4'), { engine: boundary });
  assert.equal(ok.ok, true);
});

test('deadline abort rejects a hanging extraction as timeout', async () => {
  const hanging: Parameters<typeof extractPdfText>[1]['engine'] = async () => new Promise(() => { /* never settles */ });
  const result = await extractPdfText(new TextEncoder().encode('%PDF-1.4'), { engine: hanging, deadlineMs: 30 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  const rejecting = async () => { throw new Error('engine exploded'); };
  const failed = await extractPdfText(new TextEncoder().encode('%PDF-1.4'), { engine: rejecting });
  assert.deepEqual(failed, { ok: false, reason: 'malformed' });
});

test('engine password exceptions classify as encrypted', async () => {
  const passwordEngine = async () => { throw new Error('PasswordException: Invalid password'); };
  const result = await extractPdfText(new TextEncoder().encode('%PDF-1.4'), { engine: passwordEngine });
  assert.deepEqual(result, { ok: false, reason: 'encrypted' });
});
