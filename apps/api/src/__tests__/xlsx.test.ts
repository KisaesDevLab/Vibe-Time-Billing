// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Minimal .xlsx reader used by the client importer: first sheet → header +
// rows, cells positioned by their A1 reference so omitted blanks stay
// aligned, shared + inline strings, numbers as text.

import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';

import { columnIndex, parseXlsx, XlsxParseError } from '../lib/xlsx';

/** Build a tiny workbook the way Excel/UltraTax lay it out. */
function workbook(opts: {
  sheetXml: string;
  shared?: string[];
  sheetPath?: string;
  omitRels?: boolean;
}): Buffer {
  const zip = new AdmZip();
  const sheetPath = opts.sheetPath ?? 'worksheets/sheet1.xml';
  zip.addFile(
    'xl/workbook.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Export" sheetId="1" r:id="rId7"/></sheets></workbook>`,
    ),
  );
  if (!opts.omitRels) {
    zip.addFile(
      'xl/_rels/workbook.xml.rels',
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/styles" Target="styles.xml"/><Relationship Id="rId7" Type="x/worksheet" Target="${sheetPath}"/></Relationships>`,
      ),
    );
  }
  if (opts.shared) {
    zip.addFile(
      'xl/sharedStrings.xml',
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${opts.shared.length}" uniqueCount="${opts.shared.length}">${opts.shared
          .map((s) => `<si><t>${s}</t></si>`)
          .join('')}</sst>`,
      ),
    );
  }
  zip.addFile(
    `xl/${sheetPath}`,
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${opts.sheetXml}</sheetData></worksheet>`,
    ),
  );
  return zip.toBuffer();
}

describe('columnIndex', () => {
  it('maps column letters to zero-based indexes', () => {
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('C')).toBe(2);
    expect(columnIndex('Z')).toBe(25);
    expect(columnIndex('AA')).toBe(26);
    expect(columnIndex('AV')).toBe(47);
  });
});

describe('parseXlsx', () => {
  it('reads header + rows with shared strings, keeping omitted cells aligned', () => {
    const shared = [
      'Client ID',
      'Client name',
      'Contact address 2',
      'Filing status',
      'ZIMM4432',
      'Zimmerman, Kyler',
      'Married filing joint',
    ];
    const buf = workbook({
      shared,
      sheetXml:
        `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>` +
        // C2 (address 2) omitted entirely, as UltraTax does for blanks.
        `<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="D2" t="s"><v>6</v></c></row>` +
        // Numeric cell + a styled blank self-closing cell.
        `<row r="3"><c r="A3"><v>12345</v></c><c r="B3" t="inlineStr"><is><t>Inline &amp; Co</t></is></c><c r="C3" s="2"/><c r="D3" t="s"><v>3</v></c></row>` +
        // Trailing empty row is dropped.
        `<row r="4"><c r="A4" s="2"/></row>`,
    });
    const t = parseXlsx(buf);
    expect(t.header).toEqual(['Client ID', 'Client name', 'Contact address 2', 'Filing status']);
    expect(t.rows).toEqual([
      ['ZIMM4432', 'Zimmerman, Kyler', '', 'Married filing joint'],
      ['12345', 'Inline & Co', '', 'Filing status'],
    ]);
  });

  it('follows workbook rels to a non-default sheet path and falls back without rels', () => {
    const xml = `<row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Acme</t></is></c></row>`;
    const viaRels = parseXlsx(workbook({ sheetXml: xml, sheetPath: 'worksheets/sheet9.xml' }));
    expect(viaRels.rows).toEqual([['Acme']]);
    const fallback = parseXlsx(workbook({ sheetXml: xml, omitRels: true }));
    expect(fallback.rows).toEqual([['Acme']]);
  });

  it('rejects non-workbook bytes', () => {
    expect(() => parseXlsx(Buffer.from('name,foo\nAcme,bar\n'))).toThrow(XlsxParseError);
    const zip = new AdmZip();
    zip.addFile('README.txt', Buffer.from('not a workbook'));
    expect(() => parseXlsx(zip.toBuffer())).toThrow(XlsxParseError);
  });

  it('honours maxRows by stopping early', () => {
    const rows = Array.from(
      { length: 10 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>r${i}</t></is></c></row>`,
    ).join('');
    const t = parseXlsx(workbook({ sheetXml: rows }), { maxRows: 3 });
    // header + maxRows + 1 (so the caller can detect "too many").
    expect(t.rows.length).toBe(4);
  });
});
