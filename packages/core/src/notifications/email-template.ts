// SPDX-License-Identifier: Elastic-2.0
//
// Branded HTML wrapper for transactional emails. Many call sites send a
// plain-text body only; this turns that into a simple, email-client-safe HTML
// document with a firm header (logo or name) and a support footer. Pure — the
// caller supplies the firm branding. Applied at the mail-send layer only when a
// message has no HTML of its own, so emails that already render HTML are left
// untouched.

export interface EmailBranding {
  firmName?: string | null;
  /** Absolute URL — email clients can't resolve relative paths. */
  logoUrl?: string | null;
  accentColor?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Turn a plain-text body into HTML: escape, linkify bare URLs (so sign-in /
// payment links stay clickable), and preserve line breaks.
function textToHtml(text: string, accent: string): string {
  const escaped = esc(text);
  const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    // Strip a trailing sentence period from the visible/linked URL.
    const trimmed = url.replace(/[.,]+$/, '');
    const tail = url.slice(trimmed.length);
    return `<a href="${trimmed}" style="color:${accent};">${trimmed}</a>${tail}`;
  });
  return linked.replace(/\n/g, '<br>');
}

/**
 * Wrap a plain-text email body in a branded HTML document. Inline styles only
 * (email clients strip <style>/external CSS). Safe to send as the `html`
 * alternative alongside the original text body.
 */
function brandedShell(innerHtml: string, branding: EmailBranding): string {
  const accent = branding.accentColor || '#0f6cbd';
  const firmName = branding.firmName || 'Your accounting firm';

  const header = branding.logoUrl
    ? `<img src="${esc(branding.logoUrl)}" alt="${esc(firmName)}" style="max-height:48px;max-width:220px;object-fit:contain;" />`
    : `<div style="font-size:18px;font-weight:600;color:${accent};">${esc(firmName)}</div>`;

  const support: string[] = [];
  if (branding.supportEmail) {
    support.push(
      `<a href="mailto:${esc(branding.supportEmail)}" style="color:${accent};">${esc(
        branding.supportEmail,
      )}</a>`,
    );
  }
  if (branding.supportPhone) support.push(esc(branding.supportPhone));
  const footer = support.length
    ? `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
         Questions? ${support.join(' &middot; ')}
       </div>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;">
    <div style="max-width:560px;margin:0 auto;padding:24px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,sans-serif;color:#111827;">
        <div style="margin-bottom:20px;">${header}</div>
        <div style="font-size:14px;line-height:1.55;color:#111827;">
          ${innerHtml}
        </div>
        ${footer}
      </div>
      <div style="text-align:center;font-size:11px;color:#9ca3af;margin-top:12px;">${esc(
        firmName,
      )}</div>
    </div>
  </body>
</html>`;
}

/** Wrap a plain-text email body in the branded HTML shell. */
export function wrapPlainTextEmail(opts: { text: string; branding: EmailBranding }): string {
  const accent = opts.branding.accentColor || '#0f6cbd';
  return brandedShell(textToHtml(opts.text, accent), opts.branding);
}

/** Wrap an HTML *snippet* (e.g. a few <p> tags) in the branded shell. */
export function wrapHtmlSnippet(opts: { html: string; branding: EmailBranding }): string {
  return brandedShell(opts.html, opts.branding);
}

/** True when the HTML is already a complete document (don't re-wrap these). */
export function isFullHtmlDocument(html: string): boolean {
  return /<!doctype|<html[\s>]/i.test(html);
}
