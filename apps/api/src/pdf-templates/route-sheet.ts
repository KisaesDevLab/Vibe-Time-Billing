// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0155 — printable "File Routing Sheet" HTML, rendered to PDF by
// apps/api/src/pdf/render.ts (Puppeteer). One page per engagement. A
// faithful HTML replica of the firm's paper routing form: known data is
// auto-filled; operational checkboxes / handwriting lines stay blank for
// staff to mark by hand. Pure function (data in → HTML out).

import type { RouteSheetItemSnapshot } from '@vibe/db/schema';

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

// A labelled checkbox group like "[Paper Folder] [Email] [Portal]" — all
// boxes blank (staff tick by hand on the printout).
function boxes(labels: string[]): string {
  return labels.map((l) => `<span class="cb"><span class="box"></span>${esc(l)}</span>`).join('');
}

function sheet(item: RouteSheetItemSnapshot): string {
  const c = item.client;
  const primary = c.contacts[0];
  const secondary = c.contacts[1];
  const contactCell = (
    who: 'PRIMARY' | 'SECONDARY',
    ct:
      | { name: string; email: string | null; home: string | null; mobile: string | null }
      | undefined,
  ): string => `
    <td class="contact">
      <div class="who">${who}</div>
      <div class="nm">${val(ct?.name)}</div>
      <div class="ln">Email: ${val(ct?.email)}</div>
      <div class="ln">Home: ${val(ct?.home)}</div>
      <div class="ln">Mobile: ${val(ct?.mobile)}</div>
    </td>`;

  return `
  <div class="sheet">
    <div class="clienthead">CLIENT: ${val(c.name)}</div>
    <div class="title">FILE ROUTING SHEET</div>

    <table class="contactlog">
      ${[0, 1, 2, 3]
        .map(
          () => `<tr>
        <td class="dateby">Date/By ____________</td>
        <td class="chan">${boxes(['PHN', 'VM', 'EM', 'SMS'])}</td>
      </tr>`,
        )
        .join('')}
    </table>

    <div class="section">I. ENGAGEMENT</div>
    <table class="engtbl">
      <tr>
        <td><span class="lab">Engagement:</span> ${val(item.engagementName)}</td>
        <td><span class="lab">Period:</span> ${val(item.periodLabel)}</td>
      </tr>
      <tr>
        <td><span class="lab">Owner:</span> ${val(item.partnerName)}</td>
        <td><span class="lab">Manager:</span> ${val(item.managerName)}</td>
      </tr>
      <tr>
        <td><span class="lab">Status:</span> <strong>${val(item.workflowStateLabel)}</strong></td>
        <td><span class="lab">Date Project Due:</span> ${val(item.dueDate)}</td>
      </tr>
      <tr>
        <td colspan="2"><span class="lab">Assignees:</span> ${
          item.assignees.length ? esc(item.assignees.join(', ')) : '&nbsp;'
        }</td>
      </tr>
    </table>

    <table class="contacts">
      <tr>
        ${contactCell('PRIMARY', primary)}
        ${contactCell('SECONDARY', secondary)}
      </tr>
    </table>
    <div class="row"><span class="lab">Address:</span> <span class="cval">${val(c.address)}</span></div>

    <div class="grp">
      <div class="grplab">DELIVER PROJECT VIA</div>
      ${boxes(['Pickup Paper', 'Email', 'SafeSend', 'Priority Mail', 'Meeting', 'Portal', 'E-Sign'])}
    </div>
    <div class="grp">
      <div class="grplab">PROJECT DOCUMENTS STORED IN</div>
      ${boxes(['Paper Folder', 'Email', 'Scanned to WP Folder', 'Inbox Folder', 'Portal'])}
    </div>
    <div class="grp">
      <div class="grplab">CONTACT WHEN READY</div>
      ${boxes(['Phone', 'VM', 'Email', 'SMS'])}
    </div>

    <table class="signoff">
      <tr>
        <td>PARTNER REVIEW<br/>___/___/____</td>
        <td>STAFF PREPARER<br/>___/___/____</td>
        <td>ASSEMBLED/SENT BY<br/>___/___/____</td>
      </tr>
      <tr>
        <td>PICKUP ___/___/___</td>
        <td>SIGNATURE</td>
        <td>CONFIRMATION</td>
      </tr>
    </table>

    <div class="section">III. SPECIAL INSTRUCTIONS / HANDLING / NOTES</div>
    <div class="notes">${item.note.trim() ? esc(item.note).replace(/\n/g, '<br/>') : '&nbsp;'}</div>
  </div>`;
}

/** Render a full multi-page route-sheet document (one page per engagement). */
export function renderRouteSheetHtml(items: RouteSheetItemSnapshot[]): string {
  const body = items.map(sheet).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 11px; margin: 0; }
  .sheet { padding: 4px 2px; page-break-after: always; }
  .sheet:last-child { page-break-after: auto; }
  .clienthead { text-align: left; font-size: 16px; font-weight: bold; margin-bottom: 2px; }
  .title { text-align: center; font-size: 16px; font-weight: bold; letter-spacing: 1px; border-bottom: 2px solid #111; padding-bottom: 4px; margin-bottom: 6px; }
  .section { background: #111; color: #fff; font-weight: bold; padding: 2px 6px; margin: 8px 0 4px; font-size: 11px; }
  .row { margin: 3px 0; }
  .lab { font-weight: bold; text-transform: uppercase; font-size: 10px; color: #333; }
  .cval { border-bottom: 1px solid #999; display: inline-block; min-width: 60%; }
  table { width: 100%; border-collapse: collapse; }
  .contactlog td { border: 1px solid #ccc; padding: 3px 6px; font-size: 10px; }
  .dateby { width: 45%; }
  .engtbl td { border: 1px solid #ccc; padding: 4px 6px; width: 50%; vertical-align: top; }
  .contacts td.contact { border: 1px solid #ccc; padding: 4px 6px; width: 50%; vertical-align: top; }
  .contact .who { font-weight: bold; font-size: 10px; color: #333; }
  .contact .nm { font-weight: bold; }
  .contact .ln { font-size: 10px; }
  .grp { margin: 6px 0; }
  .grplab { font-weight: bold; text-transform: uppercase; font-size: 10px; color: #333; margin-bottom: 2px; }
  .cb { display: inline-block; margin-right: 12px; font-size: 10px; white-space: nowrap; }
  .box { display: inline-block; width: 10px; height: 10px; border: 1px solid #333; margin-right: 4px; vertical-align: middle; }
  .signoff td { border: 1px solid #ccc; padding: 8px 6px; text-align: center; font-size: 10px; font-weight: bold; width: 33.33%; }
  .notes { border: 1px solid #999; min-height: 90px; padding: 6px; white-space: pre-wrap; }
</style></head><body>${body}</body></html>`;
}
