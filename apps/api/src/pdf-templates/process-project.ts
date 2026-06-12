// SPDX-License-Identifier: Elastic-2.0
//
// Printable "Process Project" HTML, rendered to PDF by
// apps/api/src/pdf/render.ts (Puppeteer). A faithful replica of the
// firm's PROCESS PROJECT form. One project per sheet. Known data is
// auto-filled; the staff-chosen dropdown values (delivery / documents /
// matching) + tax year + notes are printed; the operational checkboxes /
// handwriting lines stay blank. Pure function (data in → HTML out).
// Unlike the route sheet, printing a process project is NOT logged.

export interface ProcessProjectData {
  clientName: string;
  taxYear: string;
  period: string | null;
  responsibleLead: string | null;
  responsibleStaff: string | null;
  delivery: string;
  documents: string;
  matching: string;
  notes: string;
  address: string | null;
  contacts: Array<{
    name: string;
    email: string | null;
    home: string | null;
    mobile: string | null;
  }>;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function val(s: string | null | undefined): string {
  return s && s.trim() ? esc(s) : '&nbsp;';
}
function boxes(labels: string[]): string {
  return labels.map((l) => `<span class="cb"><span class="box"></span>${esc(l)}</span>`).join('');
}

export function renderProcessProjectHtml(d: ProcessProjectData): string {
  const primary = d.contacts[0];
  const secondary = d.contacts[1];
  const contactCell = (
    who: 'PRIMARY' | 'SECONDARY',
    ct: ProcessProjectData['contacts'][number] | undefined,
  ): string => `
    <td class="contact">
      <div class="who">${who}</div>
      <div class="nm">${val(ct?.name)}</div>
      <div class="ln">Email: ${val(ct?.email)}</div>
      <div class="ln">Home: ${val(ct?.home)}</div>
      <div class="ln">Mobile: ${val(ct?.mobile)}</div>
    </td>`;

  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 11px; margin: 0; }
  .sheet { padding: 4px 2px; }
  .clienthead { text-align: left; font-size: 16px; font-weight: bold; margin-bottom: 2px; }
  .title { text-align: center; font-size: 16px; font-weight: bold; letter-spacing: 1px; border-bottom: 2px solid #111; padding-bottom: 4px; margin-bottom: 6px; }
  .section { background: #111; color: #fff; font-weight: bold; padding: 2px 6px; margin: 8px 0 4px; font-size: 11px; }
  .row { margin: 3px 0; }
  .lab { font-weight: bold; text-transform: uppercase; font-size: 10px; color: #333; }
  .cval { border-bottom: 1px solid #999; display: inline-block; min-width: 55%; }
  table { width: 100%; border-collapse: collapse; }
  .contactlog td { border: 1px solid #ccc; padding: 3px 6px; font-size: 10px; }
  .dateby { width: 45%; }
  .infotbl td { border: 1px solid #ccc; padding: 4px 6px; width: 50%; vertical-align: top; }
  .contacts td.contact { border: 1px solid #ccc; padding: 4px 6px; width: 50%; vertical-align: top; }
  .contact .who { font-weight: bold; font-size: 10px; color: #333; }
  .contact .nm { font-weight: bold; }
  .contact .ln { font-size: 10px; }
  .deliver { margin: 6px 0; font-size: 12px; }
  .cb { display: inline-block; margin-right: 12px; font-size: 10px; white-space: nowrap; }
  .box { display: inline-block; width: 10px; height: 10px; border: 1px solid #333; margin-right: 4px; vertical-align: middle; }
  .notes { border: 1px solid #999; min-height: 110px; padding: 6px; white-space: pre-wrap; }
</style></head><body>
  <div class="sheet">
    <div class="clienthead">CLIENT: ${val(d.clientName)}</div>
    <div class="title">PROCESS PROJECT</div>

    <table class="contactlog">
      ${[0, 1, 2, 3]
        .map(
          () => `<tr>
        <td class="dateby">Date/By ____________</td>
        <td>${boxes(['PHN', 'VM', 'EM', 'SMS'])}</td>
      </tr>`,
        )
        .join('')}
    </table>
    <div class="row">${boxes(['Pickup', 'Payment'])} ___/___/___ ${boxes(['Sign', 'EFile'])}</div>

    <div class="section">II. PROJECT INFORMATION</div>
    <table class="infotbl">
      <tr>
        <td><span class="lab">Period:</span> ${val(d.period)}</td>
        <td><span class="lab">Tax Year:</span> ${val(d.taxYear)}</td>
      </tr>
      <tr>
        <td><span class="lab">Responsible Lead:</span> ${val(d.responsibleLead)}</td>
        <td><span class="lab">Responsible Staff:</span> ${val(d.responsibleStaff)}</td>
      </tr>
      <tr>
        <td><span class="lab">Documents:</span> ${val(d.documents)}</td>
        <td><span class="lab">Matching:</span> ${val(d.matching)}</td>
      </tr>
    </table>

    <table class="contacts">
      <tr>
        ${contactCell('PRIMARY', primary)}
        ${contactCell('SECONDARY', secondary)}
      </tr>
    </table>
    <div class="row"><span class="lab">Address:</span> <span class="cval">${val(d.address)}</span></div>

    <div class="deliver"><span class="lab">Deliver Project Via:</span> <strong>${val(d.delivery)}</strong></div>

    <div class="section">III. SPECIAL INSTRUCTIONS / HANDLING / NOTES</div>
    <div class="notes">${d.notes.trim() ? esc(d.notes).replace(/\n/g, '<br/>') : '&nbsp;'}</div>
  </div>
</body></html>`;
}
