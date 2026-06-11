// SPDX-License-Identifier: Elastic-2.0
//
// Connect D.7 — Realization-defense PDF export.
//
// Internal firm-only document. Lists every time entry on an engagement
// with its linked thread messages rendered inline as appendix. Used
// to defend realization on a write-up dispute — the partner can hand
// the partner panel a single PDF that proves "yes we did the work
// and here are the conversations that drove each entry".
//
// Critical security semantic: this document is NEVER sent to the
// client. The route requires engagement:read at the firm scope and
// the HTML banner makes the intent obvious.

import { and, eq, inArray, asc } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  appUsers,
  clients,
  engagementThreadLinks,
  engagements,
  firms,
  messages,
  timeEntries,
  timeEntryMessageLinks,
  workCodes,
} from '@vibe/db/schema';

import { batchDecryptForThread } from '../engagement-messaging/thread-crypto';

const HIGH_LINK_THRESHOLD = 5; // TOC threshold per D.7 spec.

export interface BuildOptions {
  db: Database;
  engagementId: string;
  firmId: string;
}

export interface DefenseSummary {
  engagementName: string;
  clientName: string;
  firmName: string;
  generatedAt: string;
  entryCount: number;
  linkedMessageCount: number;
  totalHours: number;
}

interface EntryWithLinks {
  id: string;
  entryDate: string;
  hours: number;
  billableFlag: boolean;
  inScopeFlag: boolean;
  outOfScopeOverride: boolean;
  description: string;
  staffName: string | null;
  workCodeName: string | null;
  rateCents: number;
  amountCents: number;
  costCents: number;
  approverName: string | null;
  messageBodies: Array<{
    id: string;
    createdAt: string;
    body: string;
    senderKind: 'staff' | 'client';
  }>;
}

export interface DefensePayload {
  summary: DefenseSummary;
  entries: EntryWithLinks[];
}

export async function buildDefensePayload(opts: BuildOptions): Promise<DefensePayload | null> {
  const { db, engagementId, firmId } = opts;

  // 1. Engagement + client + firm scope guard.
  const [engRow] = await db
    .select({
      id: engagements.id,
      name: engagements.name,
      clientId: engagements.clientId,
      clientFirmId: clients.firmId,
      clientName: clients.name,
    })
    .from(engagements)
    .innerJoin(clients, eq(clients.id, engagements.clientId))
    .where(eq(engagements.id, engagementId))
    .limit(1);
  if (!engRow || engRow.clientFirmId !== firmId) return null;
  const [firmRow] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, firmId))
    .limit(1);

  // 2. Time entries on the engagement.
  const teRows = await db
    .select({
      id: timeEntries.id,
      entryDate: timeEntries.entryDate,
      hours: timeEntries.hours,
      billableFlag: timeEntries.billableFlag,
      inScopeFlag: timeEntries.inScopeFlag,
      outOfScopeOverride: timeEntries.outOfScopeOverride,
      description: timeEntries.description,
      staffId: timeEntries.appUserId,
      staffName: appUsers.fullName,
      workCodeId: timeEntries.workCodeId,
      rateCents: timeEntries.standardRateSnapshotCents,
      amountCents: timeEntries.standardAmountCents,
      costRateCents: timeEntries.costRateSnapshotCents,
      approverId: timeEntries.approverId,
    })
    .from(timeEntries)
    .leftJoin(appUsers, eq(appUsers.id, timeEntries.appUserId))
    .where(eq(timeEntries.engagementId, engagementId))
    .orderBy(asc(timeEntries.entryDate));

  if (teRows.length === 0) {
    return {
      summary: {
        engagementName: engRow.name,
        clientName: engRow.clientName,
        firmName: firmRow?.name ?? '—',
        generatedAt: new Date().toISOString(),
        entryCount: 0,
        linkedMessageCount: 0,
        totalHours: 0,
      },
      entries: [],
    };
  }

  // 3. Work-code names (one trip).
  const workCodeIds = teRows
    .map((r) => r.workCodeId)
    .filter((x): x is string => typeof x === 'string');
  const wcRows = workCodeIds.length
    ? await db
        .select({ id: workCodes.id, name: workCodes.name })
        .from(workCodes)
        .where(inArray(workCodes.id, workCodeIds))
    : [];
  const wcById = new Map(wcRows.map((r) => [r.id, r.name]));

  // 4. Approver names.
  const approverIds = teRows
    .map((r) => r.approverId)
    .filter((x): x is string => typeof x === 'string');
  const approverRows = approverIds.length
    ? await db
        .select({ id: appUsers.id, name: appUsers.fullName })
        .from(appUsers)
        .where(inArray(appUsers.id, approverIds))
    : [];
  const approverById = new Map(approverRows.map((r) => [r.id, r.name]));

  // 5. Linked messages — single thread per engagement; one decrypt
  //    pass for the whole batch.
  const [link] = await db
    .select({ threadId: engagementThreadLinks.threadId })
    .from(engagementThreadLinks)
    .where(eq(engagementThreadLinks.engagementId, engagementId))
    .limit(1);

  const teIds = teRows.map((r) => r.id);
  const linkRows = link
    ? await db
        .select({
          timeEntryId: timeEntryMessageLinks.timeEntryId,
          messageId: timeEntryMessageLinks.messageId,
          sequence: timeEntryMessageLinks.sequence,
        })
        .from(timeEntryMessageLinks)
        .where(inArray(timeEntryMessageLinks.timeEntryId, teIds))
    : [];

  const allMessageIds = Array.from(new Set(linkRows.map((r) => r.messageId)));
  const msgRows = allMessageIds.length
    ? await db
        .select({
          id: messages.id,
          createdAt: messages.createdAt,
          body: messages.bodyCiphertext,
          senderAppUserId: messages.senderAppUserId,
        })
        .from(messages)
        .where(and(inArray(messages.id, allMessageIds), eq(messages.threadId, link!.threadId)))
    : [];

  let plaintextById = new Map<string, string>();
  if (link && msgRows.length > 0) {
    try {
      const plaintexts = await batchDecryptForThread(
        { db, firmId, threadId: link.threadId },
        msgRows.map((r) => r.body),
      );
      plaintextById = new Map(msgRows.map((r, i) => [r.id, plaintexts[i] ?? '']));
    } catch {
      // If decrypt fails (vault locked, missing key) we emit a stub
      // marker — the report should still render so the partner sees
      // every other piece of evidence.
      plaintextById = new Map(msgRows.map((r) => [r.id, '[decrypt failed]']));
    }
  }

  // 6. Group messages per time-entry, sorted by sequence then time.
  const messagesByEntry = new Map<
    string,
    Array<{ id: string; createdAt: string; body: string; senderKind: 'staff' | 'client' }>
  >();
  for (const lr of linkRows.sort((a, b) => a.sequence - b.sequence)) {
    const msg = msgRows.find((m) => m.id === lr.messageId);
    if (!msg) continue;
    const list = messagesByEntry.get(lr.timeEntryId) ?? [];
    list.push({
      id: msg.id,
      createdAt: msg.createdAt.toISOString(),
      body: plaintextById.get(msg.id) ?? '',
      senderKind: msg.senderAppUserId ? 'staff' : 'client',
    });
    messagesByEntry.set(lr.timeEntryId, list);
  }

  const entries: EntryWithLinks[] = teRows.map((r) => ({
    id: r.id,
    entryDate:
      typeof r.entryDate === 'string'
        ? r.entryDate
        : new Date(r.entryDate).toISOString().slice(0, 10),
    hours: Number(r.hours),
    billableFlag: r.billableFlag,
    inScopeFlag: r.inScopeFlag,
    outOfScopeOverride: r.outOfScopeOverride,
    description: r.description,
    staffName: r.staffName,
    workCodeName: r.workCodeId ? (wcById.get(r.workCodeId) ?? null) : null,
    rateCents: Number(r.rateCents),
    amountCents: Number(r.amountCents),
    costCents: Number(r.hours) * Number(r.costRateCents ?? 0),
    approverName: r.approverId ? (approverById.get(r.approverId) ?? null) : null,
    messageBodies: messagesByEntry.get(r.id) ?? [],
  }));

  const summary: DefenseSummary = {
    engagementName: engRow.name,
    clientName: engRow.clientName,
    firmName: firmRow?.name ?? '—',
    generatedAt: new Date().toISOString(),
    entryCount: entries.length,
    linkedMessageCount: linkRows.length,
    totalHours: entries.reduce((s, e) => s + e.hours, 0),
  };

  return { summary, entries };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function renderDefenseHtml(payload: DefensePayload): string {
  const { summary, entries } = payload;

  // TOC — only entries with HIGH_LINK_THRESHOLD or more messages get
  // a TOC anchor so the partner can jump directly to the heavy ones.
  const heavyEntries = entries.filter((e) => e.messageBodies.length >= HIGH_LINK_THRESHOLD);
  const toc = heavyEntries.length
    ? `<nav class="toc">
        <h2>Entries with extensive linked discussion (${heavyEntries.length})</h2>
        <ul>
          ${heavyEntries
            .map(
              (e) =>
                `<li><a href="#entry-${e.id}">${escapeHtml(e.entryDate)} — ${e.hours.toFixed(2)}h — ${escapeHtml(e.description.slice(0, 60))}</a> <span class="muted">(${e.messageBodies.length} msgs)</span></li>`,
            )
            .join('')}
        </ul>
      </nav>`
    : '';

  const entryBlocks = entries
    .map(
      (e) => `
        <section class="entry" id="entry-${e.id}">
          <header>
            <div class="entry-head">
              <span class="entry-date">${escapeHtml(e.entryDate)}</span>
              <span class="entry-hours">${e.hours.toFixed(2)}h</span>
              <span class="entry-staff">${escapeHtml(e.staffName ?? '—')}</span>
              <span class="entry-work">${escapeHtml(e.workCodeName ?? '—')}</span>
            </div>
            <div class="entry-amounts">
              Rate ${money(e.rateCents)} · Amount ${money(e.amountCents)} · Cost ${money(e.costCents)}
              ${e.billableFlag ? '' : '<span class="flag">NON-BILLABLE</span>'}
              ${!e.inScopeFlag || e.outOfScopeOverride ? '<span class="flag flag-warn">OUT-OF-SCOPE</span>' : ''}
              ${e.approverName ? `<span class="muted">approved by ${escapeHtml(e.approverName)}</span>` : ''}
            </div>
          </header>
          <p class="description">${escapeHtml(e.description)}</p>
          ${
            e.messageBodies.length === 0
              ? '<p class="no-msgs">No linked messages.</p>'
              : `<div class="msgs">
                  <h3>Linked messages (${e.messageBodies.length})</h3>
                  <ol>
                    ${e.messageBodies
                      .map(
                        (m) =>
                          `<li>
                            <div class="msg-meta">
                              <span class="msg-sender msg-${m.senderKind}">${m.senderKind}</span>
                              <span class="msg-time">${escapeHtml(new Date(m.createdAt).toLocaleString())}</span>
                            </div>
                            <div class="msg-body">${escapeHtml(m.body)}</div>
                          </li>`,
                      )
                      .join('')}
                  </ol>
                </div>`
          }
        </section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Realization defense — ${escapeHtml(summary.engagementName)}</title>
<style>
  @page { size: Letter; margin: 0.5in; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 11pt;
    line-height: 1.4;
    color: #1a1a1a;
  }
  .internal-banner {
    background: #ffe9a8;
    border: 2px solid #d39810;
    padding: 8px 12px;
    margin-bottom: 16px;
    font-weight: 700;
    text-align: center;
  }
  h1 { font-size: 18pt; margin: 0 0 4px; }
  h2 { font-size: 13pt; margin: 16pt 0 8pt; border-bottom: 1px solid #ddd; padding-bottom: 2pt; }
  h3 { font-size: 11pt; margin: 8pt 0 4pt; color: #555; }
  .meta { color: #555; font-size: 10pt; margin-bottom: 16pt; }
  .meta dt { float: left; clear: left; width: 110pt; font-weight: 600; }
  .meta dd { margin: 0; padding-left: 110pt; }
  .toc { background: #f5f5f7; padding: 12pt; border-radius: 4pt; margin-bottom: 16pt; }
  .toc ul { padding-left: 18pt; margin: 6pt 0 0; }
  .toc li { font-size: 10pt; margin: 2pt 0; }
  .toc a { color: #1e40af; text-decoration: none; }
  .muted { color: #888; font-size: 9pt; }
  .entry {
    border: 1px solid #e0e0e3;
    border-radius: 4pt;
    padding: 8pt 10pt;
    margin: 10pt 0;
    page-break-inside: avoid;
  }
  .entry-head { display: flex; gap: 12pt; align-items: baseline; font-size: 11pt; }
  .entry-date { font-weight: 600; }
  .entry-hours { font-weight: 600; color: #1e40af; }
  .entry-staff { color: #444; }
  .entry-work { color: #777; font-style: italic; }
  .entry-amounts { font-size: 9pt; color: #555; margin-top: 2pt; }
  .description { font-size: 10pt; margin: 6pt 0; }
  .flag {
    display: inline-block;
    padding: 1pt 4pt;
    margin-left: 4pt;
    border-radius: 2pt;
    background: #eee;
    color: #444;
    font-size: 8pt;
    font-weight: 700;
  }
  .flag-warn { background: #fde68a; color: #92400e; }
  .msgs { margin-top: 6pt; padding-top: 6pt; border-top: 1px dashed #ccc; }
  .msgs ol { padding-left: 18pt; }
  .msgs li { margin: 6pt 0; }
  .msg-meta { font-size: 9pt; color: #666; }
  .msg-sender {
    display: inline-block;
    padding: 0 4pt;
    border-radius: 2pt;
    text-transform: uppercase;
    font-size: 8pt;
    font-weight: 600;
    margin-right: 6pt;
  }
  .msg-staff { background: #dbeafe; color: #1e40af; }
  .msg-client { background: #fce7f3; color: #9d174d; }
  .msg-body { white-space: pre-wrap; font-size: 10pt; margin-top: 2pt; }
  .no-msgs { color: #888; font-size: 9pt; font-style: italic; }
</style>
</head>
<body>
  <div class="internal-banner">INTERNAL FIRM-ONLY · DO NOT SEND TO CLIENT</div>
  <h1>Realization defense</h1>
  <dl class="meta">
    <dt>Firm</dt><dd>${escapeHtml(summary.firmName)}</dd>
    <dt>Client</dt><dd>${escapeHtml(summary.clientName)}</dd>
    <dt>Engagement</dt><dd>${escapeHtml(summary.engagementName)}</dd>
    <dt>Generated</dt><dd>${escapeHtml(new Date(summary.generatedAt).toLocaleString())}</dd>
    <dt>Entries</dt><dd>${summary.entryCount}</dd>
    <dt>Total hours</dt><dd>${summary.totalHours.toFixed(2)}</dd>
    <dt>Linked messages</dt><dd>${summary.linkedMessageCount}</dd>
  </dl>
  ${toc}
  <h2>Time entries</h2>
  ${entries.length === 0 ? '<p class="muted">No time entries logged on this engagement.</p>' : entryBlocks}
</body>
</html>`;
}
