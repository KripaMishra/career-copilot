/**
 * Byte-exact minimal PDF builder for eval fixtures (content streams contiguous
 * before the page objects), computing stream Length and xref offsets so
 * pdfjs parses the file cleanly. Shared with the unit-test helpers.
 */
export function makePdf(pages: string[], options: { encrypt?: boolean } = {}): Uint8Array {
  const contentStart = 3;
  const pageStart = contentStart + pages.length;
  const fontId = pageStart + pages.length;
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids: string[] = [];
  for (let index = 0; index < pages.length; index++) kids.push(`${pageStart + index} 0 R`);
  objects.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);
  for (const text of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  }
  for (let index = 0; index < pages.length; index++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentStart + index} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  if (options.encrypt) objects.push('<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <00000000000000000000000000000000> /P -44 >>');
  const encryptEntry = options.encrypt ? ' /Encrypt 6 0 R' : '';
  const lines: string[] = ['%PDF-1.4'];
  const offsets: number[] = [];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(lines.join('\n'), 'latin1') + 1);
    lines.push(`${index + 1} 0 obj`, objects[index], 'endobj');
  }
  const xrefOffset = Buffer.byteLength(lines.join('\n'), 'latin1') + 1;
  lines.push('xref', `0 ${objects.length + 1}`, '0000000000 65535 f ');
  for (const offset of offsets) lines.push(`${String(offset).padStart(10, '0')} 00000 n `);
  lines.push(`trailer << /Size ${objects.length + 1} /Root 1 0 R${encryptEntry} >>`, 'startxref', String(xrefOffset), '%%EOF');
  return new TextEncoder().encode(lines.join('\n'));
}

export function textPdf(text: string) { return makePdf([text]); }
