// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff SMS inbox API (addendum Phases 6–8 backend), mounted at
// /api/staff/sms behind requireAuth + requireCsrf.
//
//   GET    /conversations                 list (filters, search, cursor)
//   GET    /conversations/:id             header detail (+ composer context)
//   GET    /conversations/:id/messages    thread
//   POST   /conversations                 new outbound-initiated thread
//   POST   /conversations/:id/messages    reply (from the thread's line — D2a)
//   POST   /conversations/:id/read|unread
//   PATCH  /conversations/:id             assign / status / engagement
//   POST   /conversations/:id/link|unlink|rematch
//   POST   /conversations/bulk
//   GET    /media/:id                     stored MMS bytes
//   GET|POST|PATCH|DELETE /templates      quick replies (firm / user scope)
//   POST   /templates/:id/render
//   GET    /unread-count
//   GET    /stream                        SSE (Redis fan-out) — D14
//   GET    /engagements/:id/conversations · GET /clients/:id/conversations
//
// Visibility (D11 as built): every reader with the inbox permission sees
// every conversation except those linked to a client restricted from them
// (clients.restricted / client_access_grant).

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import IORedis, { type Redis } from 'ioredis';
import { z } from 'zod';

import { normalizePhone } from '@vibe/core/auth';
import type { PermissionKey } from '@vibe/core/rbac';
import {
  detectPiiPatterns,
  extractSmsTemplateVars,
  firstNameOf,
  renderSmsTemplate,
} from '@vibe/core/sms';
import type { Database } from '@vibe/db';
import {
  appUsers,
  clientContacts,
  clients,
  engagements,
  firmSettings,
  firms,
  persons,
  smsConversations,
  smsLines,
  smsMedia,
  smsMessages,
  smsTemplates,
  type SmsConversationStatus,
} from '@vibe/db/schema';
import { buildStorageClient, type StorageClient } from '@vibe/storage';

import { emitAudit } from '../auth/audit';
import { requirePermission, type RbacDeps } from '../auth/rbac-middleware';
import { canAccessClient, getBlockedClientIdsCached } from '../clients/access';
import { updatePerson } from '../clients/person-helpers';
import { logger } from '../logger';
import { associateConversation } from './associate';
import { smsEventChannel } from './events';
import { findPersonsByE164 } from './lookup';
import type { SmsEvent, SmsSendService } from './send-service';

// 0234 / Phase 11 — dedicated inbox keys (see packages/core/src/rbac).
const PERM_READ: PermissionKey = 'sms:read';
const PERM_WRITE: PermissionKey = 'sms:write';
const PERM_ASSIGN: PermissionKey = 'sms:assign';
const PERM_SETTINGS: PermissionKey = 'sms:settings';

export interface SmsInboxRoutesDeps extends RbacDeps {
  db: Database | null;
  smsSend: SmsSendService;
  publish?: (evt: SmsEvent) => Promise<void> | void;
  storage?: StorageClient | null;
  redisUrl?: string | null;
  now?: () => Date;
}

const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const Filter = z.enum(['unread', 'unassigned', 'triage', 'mine', 'all']);

const ListQuery = z.object({
  filter: Filter.default('all'),
  q: z.string().trim().max(120).optional(),
  clientId: z.string().regex(UUID_RE).optional(),
  engagementId: z.string().regex(UUID_RE).optional(),
  status: z.enum(['open', 'closed', 'spam']).optional(),
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const NewConversation = z.object({
  to: z.string().trim().min(3).max(32),
  body: z.string().trim().min(1).max(1600),
  lineId: z.string().regex(UUID_RE).optional(),
  clientId: z.string().regex(UUID_RE).nullable().optional(),
  personId: z.string().regex(UUID_RE).nullable().optional(),
  engagementId: z.string().regex(UUID_RE).nullable().optional(),
});

const Reply = z.object({
  body: z.string().trim().min(1).max(1600),
  engagementId: z.string().regex(UUID_RE).nullable().optional(),
});

const Patch = z
  .object({
    assignedUserId: z.string().regex(UUID_RE).nullable().optional(),
    status: z.enum(['open', 'closed', 'spam']).optional(),
    engagementId: z.string().regex(UUID_RE).nullable().optional(),
  })
  .strict();

const Link = z.object({
  clientId: z.string().regex(UUID_RE),
  personId: z.string().regex(UUID_RE).nullable().optional(),
  clientContactId: z.string().regex(UUID_RE).nullable().optional(),
  engagementId: z.string().regex(UUID_RE).nullable().optional(),
  addNumberToContact: z.enum(['mobile', 'phone']).nullable().optional(),
});

const Bulk = z.object({
  ids: z.array(z.string().regex(UUID_RE)).min(1).max(200),
  action: z.enum(['read', 'assign', 'close', 'spam', 'reopen']),
  assignedUserId: z.string().regex(UUID_RE).nullable().optional(),
});

const TemplateBody = z.object({
  name: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(1600),
  scope: z.enum(['firm', 'user']).default('user'),
});

const BLOCK_STATUS: Record<string, number> = {
  opted_out: 409,
  no_consent: 409,
  a2p_unregistered: 409,
  no_line: 409,
  invalid_number: 400,
  not_configured: 503,
  provider_error: 502,
  rate_limited: 503,
};

export function createSmsInboxRouter(deps: SmsInboxRoutesDeps): Router {
  const router = express.Router();
  const nowFn = deps.now ?? ((): Date => new Date());

  function idParam(req: Request, res: Response): string | null {
    const id = req.params['id'] ?? '';
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return id;
  }

  async function blockedFor(req: Request): Promise<Set<string>> {
    const s = req.staffSession!;
    return new Set(await getBlockedClientIdsCached(deps, req, s.appUserId, s.firmId));
  }

  /** Load one conversation the caller may see (404 otherwise). */
  async function loadVisible(
    req: Request,
    res: Response,
    id: string,
  ): Promise<typeof smsConversations.$inferSelect | null> {
    const db = deps.db!;
    const s = req.staffSession!;
    const [conv] = await db
      .select()
      .from(smsConversations)
      .where(and(eq(smsConversations.id, id), eq(smsConversations.firmId, s.firmId)))
      .limit(1);
    if (!conv) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    if (conv.clientId && !(await canAccessClient(deps, s.appUserId, s.firmId, conv.clientId))) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return conv;
  }

  async function publish(evt: SmsEvent): Promise<void> {
    try {
      await deps.publish?.(evt);
    } catch {
      /* best-effort */
    }
  }

  // ---------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------

  const lastBodySql = sql<string | null>`(
    SELECT m.body FROM vibetb.sms_message m
    WHERE m.conversation_id = ${smsConversations.id}
    ORDER BY m.created_at DESC LIMIT 1)`;
  const lastDirectionSql = sql<string | null>`(
    SELECT m.direction FROM vibetb.sms_message m
    WHERE m.conversation_id = ${smsConversations.id}
    ORDER BY m.created_at DESC LIMIT 1)`;
  const pendingRescheduleSql = sql<boolean>`EXISTS (
    SELECT 1 FROM vibetb.sms_message m
    WHERE m.conversation_id = ${smsConversations.id}
      AND m.direction = 'inbound' AND m.parsed_intent = 'reschedule' AND m.read_at IS NULL)`;

  function listSelect(db: Database) {
    return db
      .select({
        id: smsConversations.id,
        lineId: smsConversations.lineId,
        lineLabel: smsLines.label,
        lineNumber: smsLines.phoneNumberE164,
        externalNumberE164: smsConversations.externalNumberE164,
        personId: smsConversations.personId,
        personName: persons.fullName,
        personOptOut: persons.smsOptOut,
        clientContactId: smsConversations.clientContactId,
        clientId: smsConversations.clientId,
        clientName: clients.name,
        clientRestricted: clients.restricted,
        engagementId: smsConversations.engagementId,
        engagementName: engagements.name,
        engagementSuggested: smsConversations.engagementSuggested,
        linkSource: smsConversations.linkSource,
        needsTriage: smsConversations.needsTriage,
        assignedUserId: smsConversations.assignedUserId,
        assignedUserName: appUsers.fullName,
        status: smsConversations.status,
        unreadCount: smsConversations.unreadCount,
        lastMessageAt: smsConversations.lastMessageAt,
        lastInboundAt: smsConversations.lastInboundAt,
        lastOutboundAt: smsConversations.lastOutboundAt,
        lastMessagePreview: lastBodySql,
        lastDirection: lastDirectionSql,
        pendingReschedule: pendingRescheduleSql,
        createdAt: smsConversations.createdAt,
      })
      .from(smsConversations)
      .innerJoin(smsLines, eq(smsLines.id, smsConversations.lineId))
      .leftJoin(persons, eq(persons.id, smsConversations.personId))
      .leftJoin(clients, eq(clients.id, smsConversations.clientId))
      .leftJoin(engagements, eq(engagements.id, smsConversations.engagementId))
      .leftJoin(appUsers, eq(appUsers.id, smsConversations.assignedUserId));
  }

  type ListRow = Awaited<ReturnType<ReturnType<typeof listSelect>['execute']>>[number];

  function rowView(r: ListRow) {
    return {
      id: r.id,
      lineId: r.lineId,
      lineLabel: r.lineLabel ?? r.lineNumber,
      externalNumberE164: r.externalNumberE164,
      contact: r.personId
        ? { personId: r.personId, name: r.personName ?? '', smsOptOut: r.personOptOut ?? false }
        : null,
      client: r.clientId
        ? { id: r.clientId, name: r.clientName ?? '', restricted: r.clientRestricted ?? false }
        : null,
      engagement: r.engagementId
        ? { id: r.engagementId, name: r.engagementName ?? '', suggested: r.engagementSuggested }
        : null,
      assignedUser: r.assignedUserId
        ? { id: r.assignedUserId, name: r.assignedUserName ?? '' }
        : null,
      status: r.status,
      linkSource: r.linkSource,
      needsTriage: r.needsTriage,
      unreadCount: r.unreadCount,
      lastMessageAt: r.lastMessageAt,
      lastInboundAt: r.lastInboundAt,
      lastOutboundAt: r.lastOutboundAt,
      lastMessagePreview: (r.lastMessagePreview ?? '').slice(0, 160),
      lastDirection: r.lastDirection,
      pendingReschedule: Boolean(r.pendingReschedule),
      createdAt: r.createdAt,
    };
  }

  router.get('/conversations', requirePermission(deps, PERM_READ), async (req, res) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', issues: parsed.error.issues });
      return;
    }
    if (!deps.db) {
      res.json({ items: [], total: 0, nextCursor: null });
      return;
    }
    const db = deps.db;
    const s = req.staffSession!;
    const q = parsed.data;
    const blocked = await blockedFor(req);
    const conds = [eq(smsConversations.firmId, s.firmId)];
    if (blocked.size > 0) {
      conds.push(
        or(
          isNull(smsConversations.clientId),
          sql`${smsConversations.clientId} NOT IN ${[...blocked]}`,
        )!,
      );
    }
    if (q.status) conds.push(eq(smsConversations.status, q.status));
    else if (q.filter !== 'all') conds.push(eq(smsConversations.status, 'open'));
    else conds.push(ne(smsConversations.status, 'spam'));
    switch (q.filter) {
      case 'unread':
        conds.push(sql`${smsConversations.unreadCount} > 0`);
        break;
      case 'unassigned':
        conds.push(isNull(smsConversations.clientId));
        break;
      case 'triage':
        conds.push(eq(smsConversations.needsTriage, true));
        break;
      case 'mine':
        conds.push(eq(smsConversations.assignedUserId, s.appUserId));
        break;
      default:
        break;
    }
    if (q.clientId) conds.push(eq(smsConversations.clientId, q.clientId));
    if (q.engagementId) conds.push(eq(smsConversations.engagementId, q.engagementId));
    if (q.q) {
      const like = `%${q.q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      const digits = q.q.replace(/\D/g, '');
      conds.push(
        or(
          sql`${persons.fullName} ILIKE ${like}`,
          digits.length >= 4
            ? sql`${smsConversations.externalNumberE164} LIKE ${`%${digits}%`}`
            : sql`false`,
          sql`EXISTS (SELECT 1 FROM vibetb.sms_message m WHERE m.conversation_id = ${smsConversations.id} AND m.body ILIKE ${like})`,
        )!,
      );
    }
    const where = and(...conds);
    const totalRows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(smsConversations)
      .leftJoin(persons, eq(persons.id, smsConversations.personId))
      .where(where);
    const pageConds = [where];
    if (q.cursor) pageConds.push(lt(smsConversations.lastMessageAt, new Date(q.cursor)));
    const rows = await listSelect(db)
      .where(and(...pageConds))
      .orderBy(desc(smsConversations.lastMessageAt), desc(smsConversations.createdAt))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const nextCursor =
      rows.length > q.limit ? (page[page.length - 1]?.lastMessageAt?.toISOString() ?? null) : null;
    res.json({ items: page.map(rowView), total: Number(totalRows[0]?.c ?? 0), nextCursor });
  });

  // ---------------------------------------------------------------------
  // detail + messages
  // ---------------------------------------------------------------------

  async function detailView(req: Request, conv: typeof smsConversations.$inferSelect) {
    const db = deps.db!;
    const s = req.staffSession!;
    const [row] = await listSelect(db).where(eq(smsConversations.id, conv.id)).limit(1);
    const base = rowView(row!);
    const [settings] = await db
      .select({
        consentEnforced: firmSettings.smsConsentEnforced,
        a2pStatus: firmSettings.smsA2pStatus,
        a2pOverride: firmSettings.smsA2pOverrideAllow,
        piiWarnings: firmSettings.smsPiiWarningsEnabled,
      })
      .from(firmSettings)
      .where(eq(firmSettings.firmId, s.firmId))
      .limit(1);
    const [firm] = await db
      .select({ name: firms.name })
      .from(firms)
      .where(eq(firms.id, s.firmId))
      .limit(1);
    const [me] = await db
      .select({ name: appUsers.fullName })
      .from(appUsers)
      .where(eq(appUsers.id, s.appUserId))
      .limit(1);
    let person: {
      optOut: boolean;
      optOutAt: Date | null;
      optOutSource: string | null;
      consentAt: Date | null;
      consentSource: string | null;
    } | null = null;
    if (conv.personId) {
      const [p] = await db
        .select({
          optOut: persons.smsOptOut,
          optOutAt: persons.smsOptOutAt,
          optOutSource: persons.smsOptOutSource,
          consentAt: persons.smsConsentAt,
          consentSource: persons.smsConsentSource,
        })
        .from(persons)
        .where(eq(persons.id, conv.personId))
        .limit(1);
      person = p ?? null;
    }
    const candidateIds = (conv.candidatePersonIds ?? []) as string[];
    const candidates =
      candidateIds.length > 0
        ? await db
            .select({
              personId: persons.id,
              name: persons.fullName,
              clientId: clientContacts.clientId,
              clientName: clients.name,
              clientContactId: clientContacts.id,
            })
            .from(persons)
            .innerJoin(
              clientContacts,
              and(eq(clientContacts.personId, persons.id), eq(clientContacts.status, 'ACTIVE')),
            )
            .innerJoin(clients, eq(clients.id, clientContacts.clientId))
            .where(inArray(persons.id, candidateIds))
        : [];
    const engagementOptions = conv.clientId
      ? await db
          .select({ id: engagements.id, name: engagements.name, status: engagements.status })
          .from(engagements)
          .where(and(eq(engagements.clientId, conv.clientId), ne(engagements.status, 'ARCHIVED')))
          .orderBy(asc(engagements.name))
      : [];
    const inboundInitiated = Boolean(conv.lastInboundAt);
    let replyBlockReason:
      | 'opted_out'
      | 'consent_required'
      | 'a2p_unregistered'
      | 'closed'
      | 'spam'
      | null = null;
    if (conv.status === 'spam') replyBlockReason = 'spam';
    else if (conv.status === 'closed') replyBlockReason = 'closed';
    else if (person?.optOut) replyBlockReason = 'opted_out';
    else if (settings?.consentEnforced && person && !person.consentAt && !inboundInitiated) {
      replyBlockReason = 'consent_required';
    } else if (settings?.a2pStatus === 'unregistered' && !settings.a2pOverride) {
      replyBlockReason = 'a2p_unregistered';
    }
    return {
      ...base,
      candidates,
      consent: { at: person?.consentAt ?? null, source: person?.consentSource ?? null },
      optOut: {
        active: person?.optOut ?? false,
        at: person?.optOutAt ?? null,
        source: person?.optOutSource ?? null,
      },
      inboundInitiated,
      canReply: replyBlockReason === null,
      replyBlockReason,
      piiWarningsEnabled: settings?.piiWarnings ?? true,
      templateVars: {
        client_first: firstNameOf(base.contact?.name ?? base.client?.name ?? null) || null,
        engagement_name: base.engagement?.name ?? null,
        staff_first: firstNameOf(me?.name ?? null) || null,
        firm: firm?.name ?? null,
      },
      engagementOptions,
    };
  }

  router.get('/conversations/:id', requirePermission(deps, PERM_READ), async (req, res) => {
    const id = idParam(req, res);
    if (!id || !deps.db) return;
    const conv = await loadVisible(req, res, id);
    if (!conv) return;
    res.json(await detailView(req, conv));
  });

  async function mediaViews(db: Database, messageIds: string[]) {
    if (messageIds.length === 0) return new Map<string, unknown[]>();
    const rows = await db
      .select({
        id: smsMedia.id,
        messageId: smsMedia.messageId,
        contentType: smsMedia.contentType,
        sizeBytes: smsMedia.sizeBytes,
        status: smsMedia.status,
        intakeSessionId: smsMedia.intakeSessionId,
        intakeFileId: smsMedia.intakeFileId,
        storageKey: smsMedia.storageKey,
      })
      .from(smsMedia)
      .where(inArray(smsMedia.messageId, messageIds));
    const out = new Map<string, unknown[]>();
    for (const r of rows) {
      const list = out.get(r.messageId) ?? [];
      list.push({
        id: r.id,
        contentType: r.contentType,
        sizeBytes: r.sizeBytes,
        status: r.status,
        intakeSessionId: r.intakeSessionId,
        intakeFileId: r.intakeFileId,
        url: r.storageKey ? `/api/staff/sms/media/${r.id}` : null,
      });
      out.set(r.messageId, list);
    }
    return out;
  }

  router.get(
    '/conversations/:id/messages',
    requirePermission(deps, PERM_READ),
    async (req, res) => {
      const id = idParam(req, res);
      if (!id || !deps.db) return;
      const conv = await loadVisible(req, res, id);
      if (!conv) return;
      const before = typeof req.query['before'] === 'string' ? new Date(req.query['before']) : null;
      const limit = Math.min(Math.max(Number(req.query['limit'] ?? 100) || 100, 1), 500);
      const conds = [eq(smsMessages.conversationId, id)];
      if (before && !Number.isNaN(before.getTime())) conds.push(lt(smsMessages.createdAt, before));
      const rows = await deps.db
        .select({
          m: smsMessages,
          sentByName: appUsers.fullName,
        })
        .from(smsMessages)
        .leftJoin(appUsers, eq(appUsers.id, smsMessages.sentByUserId))
        .where(and(...conds))
        .orderBy(desc(smsMessages.createdAt))
        .limit(limit);
      const media = await mediaViews(
        deps.db,
        rows.map((r) => r.m.id),
      );
      const items = rows.reverse().map(({ m, sentByName }) => ({
        id: m.id,
        direction: m.direction,
        body: m.body,
        providerStatus: m.providerStatus,
        providerErrorCode: m.providerErrorCode,
        providerErrorMessage: m.providerErrorMessage,
        numSegments: m.numSegments,
        numMedia: m.numMedia,
        contextKind: m.contextKind,
        engagementId: m.engagementId,
        sentBy: m.sentByUserId ? { id: m.sentByUserId, name: sentByName ?? '' } : null,
        appointmentId: m.appointmentId,
        parsedIntent: m.parsedIntent,
        readAt: m.readAt,
        redactionFlags: m.redactionFlags,
        media: media.get(m.id) ?? [],
        providerTimestamp: m.providerTimestamp,
        createdAt: m.createdAt,
      }));
      res.json({ items, hasMore: rows.length === limit });
    },
  );

  // ---------------------------------------------------------------------
  // send
  // ---------------------------------------------------------------------

  function sendError(
    res: Response,
    r: Extract<Awaited<ReturnType<SmsSendService['send']>>, { ok: false }>,
  ): void {
    res.status(BLOCK_STATUS[r.reason] ?? 500).json({
      error: r.reason === 'no_consent' ? 'sms_consent_required' : `sms_${r.reason}`,
      reason: r.reason,
      detail: r.error ?? null,
      personId: r.personId ?? null,
      conversationId: r.conversationId ?? null,
      retryable: r.retryable ?? false,
    });
  }

  router.post('/conversations', requirePermission(deps, PERM_WRITE), async (req, res) => {
    const parsed = NewConversation.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const s = req.staffSession!;
    const p = parsed.data;
    if (p.clientId && !(await canAccessClient(deps, s.appUserId, s.firmId, p.clientId))) {
      res.status(404).json({ error: 'client_not_found' });
      return;
    }
    const to = normalizePhone(p.to);
    if (!to) {
      res.status(400).json({ error: 'sms_invalid_number' });
      return;
    }
    const r = await deps.smsSend.send({
      to,
      body: p.body,
      context: {
        kind: 'manual',
        firmId: s.firmId,
        sentByUserId: s.appUserId,
        lineId: p.lineId,
        clientId: p.clientId ?? null,
        personId: p.personId ?? null,
        engagementId: p.engagementId ?? null,
      },
    });
    if (!r.ok) {
      sendError(res, r);
      return;
    }
    if (r.conversationId) {
      // A staff-picked client on a fresh thread is a manual link.
      if (p.clientId) {
        await deps.db
          .update(smsConversations)
          .set({
            linkSource: 'manual',
            needsTriage: false,
            engagementSuggested: false,
            updatedAt: nowFn(),
          })
          .where(
            and(
              eq(smsConversations.id, r.conversationId),
              ne(smsConversations.linkSource, 'manual'),
            ),
          );
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'sms_message',
        entityId: r.messageId ?? r.conversationId,
        actorAppUserId: s.appUserId,
        after: { conversationId: r.conversationId, to, smsAction: 'send' },
        ip: req.ip,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
    }
    res
      .status(201)
      .json({ ok: true, conversationId: r.conversationId, messageId: r.messageId, mode: r.mode });
  });

  router.post(
    '/conversations/:id/messages',
    requirePermission(deps, PERM_WRITE),
    async (req, res) => {
      const id = idParam(req, res);
      if (!id || !deps.db) return;
      const parsed = Reply.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
        return;
      }
      const conv = await loadVisible(req, res, id);
      if (!conv) return;
      const s = req.staffSession!;
      if (conv.status !== 'open') {
        res.status(409).json({ error: `sms_conversation_${conv.status}`, reason: conv.status });
        return;
      }
      const engagementId =
        parsed.data.engagementId !== undefined ? parsed.data.engagementId : conv.engagementId;
      const r = await deps.smsSend.send({
        to: conv.externalNumberE164,
        body: parsed.data.body,
        context: {
          kind: 'manual',
          firmId: s.firmId,
          sentByUserId: s.appUserId,
          conversationId: conv.id,
          clientId: conv.clientId,
          personId: conv.personId,
          engagementId,
        },
      });
      if (!r.ok) {
        sendError(res, r);
        return;
      }
      // D6 — the first staff reply confirms a suggested engagement (or the
      // one picked in the composer).
      const set: Partial<typeof smsConversations.$inferInsert> = { updatedAt: nowFn() };
      if (engagementId !== conv.engagementId) set.engagementId = engagementId;
      if (conv.engagementSuggested || engagementId !== conv.engagementId)
        set.engagementSuggested = false;
      if (Object.keys(set).length > 1) {
        await deps.db.update(smsConversations).set(set).where(eq(smsConversations.id, conv.id));
        if (conv.engagementSuggested && engagementId) {
          await emitAudit(deps.db, {
            action: 'UPDATE',
            entityType: 'sms_conversation',
            entityId: conv.id,
            actorAppUserId: s.appUserId,
            after: { smsAction: 'confirm_engagement', engagementId },
          }).catch(() => undefined);
        }
      }
      await emitAudit(deps.db, {
        action: 'CREATE',
        entityType: 'sms_message',
        entityId: r.messageId ?? conv.id,
        actorAppUserId: s.appUserId,
        after: { conversationId: conv.id, smsAction: 'reply' },
        ip: req.ip,
        userAgent: req.get('user-agent') ?? null,
      }).catch(() => undefined);
      res
        .status(201)
        .json({ ok: true, messageId: r.messageId, conversationId: conv.id, mode: r.mode });
    },
  );

  // Composer warning (D8): pattern flags for a draft, honoring the firm toggle.
  router.post(
    '/conversations/:id/messages/preview-flags',
    requirePermission(deps, PERM_READ),
    async (req, res) => {
      const id = idParam(req, res);
      if (!id || !deps.db) return;
      const s = req.staffSession!;
      const body = typeof req.body?.body === 'string' ? req.body.body : '';
      const [fs] = await deps.db
        .select({ on: firmSettings.smsPiiWarningsEnabled })
        .from(firmSettings)
        .where(eq(firmSettings.firmId, s.firmId))
        .limit(1);
      res.json({ flags: fs?.on === false ? [] : detectPiiPatterns(body) });
    },
  );

  // Sentinel reporting: messages carrying PII pattern flags.
  router.get('/reports/pii', requirePermission(deps, PERM_SETTINGS), async (req, res) => {
    if (!deps.db) {
      res.json({ items: [], counts: {} });
      return;
    }
    const s = req.staffSession!;
    const sinceRaw = typeof req.query['since'] === 'string' ? new Date(req.query['since']) : null;
    const since =
      sinceRaw && !Number.isNaN(sinceRaw.getTime())
        ? sinceRaw
        : new Date(Date.now() - 30 * 86_400_000);
    const rows = await deps.db
      .select({
        id: smsMessages.id,
        conversationId: smsMessages.conversationId,
        direction: smsMessages.direction,
        flags: smsMessages.redactionFlags,
        createdAt: smsMessages.createdAt,
      })
      .from(smsMessages)
      .where(
        and(
          eq(smsMessages.firmId, s.firmId),
          sql`jsonb_array_length(${smsMessages.redactionFlags}) > 0`,
          sql`${smsMessages.createdAt} >= ${since}`,
        ),
      )
      .orderBy(desc(smsMessages.createdAt))
      .limit(500);
    const counts: Record<string, number> = {};
    for (const r of rows) for (const f of r.flags ?? []) counts[f] = (counts[f] ?? 0) + 1;
    res.json({ since, items: rows, counts });
  });

  // ---------------------------------------------------------------------
  // read state, assignment, status
  // ---------------------------------------------------------------------

  async function markRead(db: Database, convId: string, userId: string, ts: Date): Promise<void> {
    await db
      .update(smsMessages)
      .set({ readAt: ts, readByUserId: userId })
      .where(
        and(
          eq(smsMessages.conversationId, convId),
          eq(smsMessages.direction, 'inbound'),
          isNull(smsMessages.readAt),
        ),
      );
    await db
      .update(smsConversations)
      .set({ unreadCount: 0, updatedAt: ts })
      .where(eq(smsConversations.id, convId));
  }

  router.post('/conversations/:id/read', requirePermission(deps, PERM_READ), async (req, res) => {
    const id = idParam(req, res);
    if (!id || !deps.db) return;
    const conv = await loadVisible(req, res, id);
    if (!conv) return;
    await markRead(deps.db, conv.id, req.staffSession!.appUserId, nowFn());
    await publish({
      type: 'sms.conversation.updated',
      firmId: conv.firmId,
      conversationId: conv.id,
      clientId: conv.clientId,
    });
    res.json({ ok: true });
  });

  router.post('/conversations/:id/unread', requirePermission(deps, PERM_READ), async (req, res) => {
    const id = idParam(req, res);
    if (!id || !deps.db) return;
    const conv = await loadVisible(req, res, id);
    if (!conv) return;
    const [last] = await deps.db
      .select({ id: smsMessages.id })
      .from(smsMessages)
      .where(and(eq(smsMessages.conversationId, conv.id), eq(smsMessages.direction, 'inbound')))
      .orderBy(desc(smsMessages.createdAt))
      .limit(1);
    if (last) {
      await deps.db
        .update(smsMessages)
        .set({ readAt: null, readByUserId: null })
        .where(eq(smsMessages.id, last.id));
    }
    await deps.db
      .update(smsConversations)
      .set({ unreadCount: last ? 1 : 0, updatedAt: nowFn() })
      .where(eq(smsConversations.id, conv.id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'sms_conversation',
      entityId: conv.id,
      actorAppUserId: req.staffSession!.appUserId,
      after: { smsAction: 'mark_unread' },
    }).catch(() => undefined);
    await publish({
      type: 'sms.conversation.updated',
      firmId: conv.firmId,
      conversationId: conv.id,
      clientId: conv.clientId,
    });
    res.json({ ok: true });
  });

  router.patch('/conversations/:id', requirePermission(deps, PERM_WRITE), async (req, res) => {
    const id = idParam(req, res);
    if (!id || !deps.db) return;
    const parsed = Patch.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const conv = await loadVisible(req, res, id);
    if (!conv) return;
    const s = req.staffSession!;
    const p = parsed.data;
    if (p.assignedUserId !== undefined) {
      // assignment needs the assign permission (same key until Phase 11)
      const gate = requirePermission(deps, PERM_ASSIGN);
      let allowed = false;
      await gate(req, { status: () => ({ json: () => undefined }) } as unknown as Response, () => {
        allowed = true;
      });
      if (!allowed) {
        res.status(403).json({ error: 'forbidden', required: PERM_ASSIGN });
        return;
      }
    }
    const ts = nowFn();
    const set: Partial<typeof smsConversations.$inferInsert> = { updatedAt: ts };
    const actions: string[] = [];
    if (p.assignedUserId !== undefined) {
      set.assignedUserId = p.assignedUserId;
      actions.push('reassign');
    }
    if (p.status !== undefined && p.status !== conv.status) {
      set.status = p.status as SmsConversationStatus;
      set.closedAt = p.status === 'open' ? null : ts;
      actions.push(p.status === 'open' ? 'reopen' : p.status);
    }
    if (p.engagementId !== undefined) {
      set.engagementId = p.engagementId;
      set.engagementSuggested = false;
      actions.push('set_engagement');
    }
    await deps.db.update(smsConversations).set(set).where(eq(smsConversations.id, conv.id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'sms_conversation',
      entityId: conv.id,
      actorAppUserId: s.appUserId,
      before: {
        assignedUserId: conv.assignedUserId,
        status: conv.status,
        engagementId: conv.engagementId,
      },
      after: { ...p, smsAction: actions.join(',') },
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
    }).catch(() => undefined);
    await publish({
      type: 'sms.conversation.updated',
      firmId: conv.firmId,
      conversationId: conv.id,
      clientId: conv.clientId,
    });
    const updated = await loadVisible(req, res, id);
    if (!updated) return;
    res.json(await detailView(req, updated));
  });

  router.post('/conversations/bulk', requirePermission(deps, PERM_WRITE), async (req, res) => {
    const parsed = Bulk.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const s = req.staffSession!;
    const blocked = await blockedFor(req);
    const rows = await deps.db
      .select({ id: smsConversations.id, clientId: smsConversations.clientId })
      .from(smsConversations)
      .where(
        and(eq(smsConversations.firmId, s.firmId), inArray(smsConversations.id, parsed.data.ids)),
      );
    const ids = rows.filter((r) => !r.clientId || !blocked.has(r.clientId)).map((r) => r.id);
    if (ids.length === 0) {
      res.json({ ok: true, updated: 0 });
      return;
    }
    const ts = nowFn();
    const a = parsed.data.action;
    if (a === 'read') {
      for (const id of ids) await markRead(deps.db, id, s.appUserId, ts);
    } else if (a === 'assign') {
      await deps.db
        .update(smsConversations)
        .set({ assignedUserId: parsed.data.assignedUserId ?? null, updatedAt: ts })
        .where(inArray(smsConversations.id, ids));
    } else {
      const status: SmsConversationStatus =
        a === 'reopen' ? 'open' : a === 'close' ? 'closed' : 'spam';
      await deps.db
        .update(smsConversations)
        .set({ status, closedAt: status === 'open' ? null : ts, updatedAt: ts })
        .where(inArray(smsConversations.id, ids));
    }
    for (const id of ids) {
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'sms_conversation',
        entityId: id,
        actorAppUserId: s.appUserId,
        after: { smsAction: `bulk_${a}`, assignedUserId: parsed.data.assignedUserId ?? undefined },
      }).catch(() => undefined);
      const row = rows.find((r) => r.id === id);
      await publish({
        type: 'sms.conversation.updated',
        firmId: s.firmId,
        conversationId: id,
        clientId: row?.clientId ?? null,
      });
    }
    res.json({ ok: true, updated: ids.length });
  });

  // ---------------------------------------------------------------------
  // linking
  // ---------------------------------------------------------------------

  router.post('/conversations/:id/link', requirePermission(deps, PERM_ASSIGN), async (req, res) => {
    const id = idParam(req, res);
    if (!id || !deps.db) return;
    const parsed = Link.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const conv = await loadVisible(req, res, id);
    if (!conv) return;
    const s = req.staffSession!;
    const p = parsed.data;
    const db = deps.db;
    if (!(await canAccessClient(deps, s.appUserId, s.firmId, p.clientId))) {
      res.status(404).json({ error: 'client_not_found' });
      return;
    }
    const [client] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, p.clientId), eq(clients.firmId, s.firmId)))
      .limit(1);
    if (!client) {
      res.status(404).json({ error: 'client_not_found' });
      return;
    }
    // Resolve the contact: explicit contact → explicit person's contact on
    // this client → the client's only ACTIVE contact matching the number.
    let contactId: string | null = p.clientContactId ?? null;
    let personId: string | null = p.personId ?? null;
    if (contactId) {
      const [c] = await db
        .select({ id: clientContacts.id, personId: clientContacts.personId })
        .from(clientContacts)
        .where(and(eq(clientContacts.id, contactId), eq(clientContacts.clientId, p.clientId)))
        .limit(1);
      if (!c) {
        res.status(400).json({ error: 'contact_not_on_client' });
        return;
      }
      personId = c.personId;
    } else if (personId) {
      const [c] = await db
        .select({ id: clientContacts.id })
        .from(clientContacts)
        .where(
          and(
            eq(clientContacts.personId, personId),
            eq(clientContacts.clientId, p.clientId),
            eq(clientContacts.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      contactId = c?.id ?? null;
    } else {
      const matches = await findPersonsByE164(db, s.firmId, conv.externalNumberE164);
      const onClient = matches.find((m) => m.clients.some((c) => c.clientId === p.clientId));
      if (onClient) {
        personId = onClient.personId;
        contactId = onClient.clients.find((c) => c.clientId === p.clientId)!.clientContactId;
      }
    }
    if (p.engagementId) {
      const [e] = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(and(eq(engagements.id, p.engagementId), eq(engagements.clientId, p.clientId)))
        .limit(1);
      if (!e) {
        res.status(400).json({ error: 'engagement_not_on_client' });
        return;
      }
    }
    if (p.addNumberToContact && personId) {
      await updatePerson(db, personId, { [p.addNumberToContact]: conv.externalNumberE164 });
    }
    const ts = nowFn();
    await db
      .update(smsConversations)
      .set({
        clientId: p.clientId,
        personId,
        clientContactId: contactId,
        engagementId: p.engagementId ?? null,
        engagementSuggested: false,
        linkSource: 'manual',
        needsTriage: false,
        candidatePersonIds: [],
        updatedAt: ts,
      })
      .where(eq(smsConversations.id, conv.id));
    // Texting first is consent; a manual link after an inbound records it.
    if (personId && conv.lastInboundAt) {
      await db
        .update(persons)
        .set({ smsConsentAt: ts, smsConsentSource: 'inbound', updatedAt: ts })
        .where(and(eq(persons.id, personId), isNull(persons.smsConsentAt)));
    }
    await emitAudit(db, {
      action: 'UPDATE',
      entityType: 'sms_conversation',
      entityId: conv.id,
      actorAppUserId: s.appUserId,
      before: { clientId: conv.clientId, personId: conv.personId, engagementId: conv.engagementId },
      after: {
        smsAction: 'link_client',
        clientId: p.clientId,
        personId,
        contactId,
        engagementId: p.engagementId ?? null,
      },
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
    }).catch(() => undefined);
    await publish({
      type: 'sms.conversation.updated',
      firmId: conv.firmId,
      conversationId: conv.id,
      clientId: p.clientId,
    });
    const updated = await loadVisible(req, res, id);
    if (!updated) return;
    res.json(await detailView(req, updated));
  });

  router.post(
    '/conversations/:id/unlink',
    requirePermission(deps, PERM_ASSIGN),
    async (req, res) => {
      const id = idParam(req, res);
      if (!id || !deps.db) return;
      const conv = await loadVisible(req, res, id);
      if (!conv) return;
      const s = req.staffSession!;
      await deps.db
        .update(smsConversations)
        .set({
          clientId: null,
          clientContactId: null,
          engagementId: null,
          engagementSuggested: false,
          linkSource: 'none',
          needsTriage: false,
          updatedAt: nowFn(),
        })
        .where(eq(smsConversations.id, conv.id));
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'sms_conversation',
        entityId: conv.id,
        actorAppUserId: s.appUserId,
        before: { clientId: conv.clientId, engagementId: conv.engagementId },
        after: { smsAction: 'unlink' },
      }).catch(() => undefined);
      await publish({
        type: 'sms.conversation.updated',
        firmId: conv.firmId,
        conversationId: conv.id,
        clientId: null,
      });
      const updated = await loadVisible(req, res, id);
      if (!updated) return;
      res.json(await detailView(req, updated));
    },
  );

  router.post(
    '/conversations/:id/rematch',
    requirePermission(deps, PERM_ASSIGN),
    async (req, res) => {
      const id = idParam(req, res);
      if (!id || !deps.db) return;
      const conv = await loadVisible(req, res, id);
      if (!conv) return;
      const result = await associateConversation(deps.db, {
        conversationId: conv.id,
        force: true,
        now: nowFn(),
      });
      await emitAudit(deps.db, {
        action: 'UPDATE',
        entityType: 'sms_conversation',
        entityId: conv.id,
        actorAppUserId: req.staffSession!.appUserId,
        after: { smsAction: 'rematch', method: result.method, clientId: result.clientId },
      }).catch(() => undefined);
      const updated = await loadVisible(req, res, id);
      if (!updated) return;
      res.json({ result: result.method, detail: await detailView(req, updated) });
    },
  );

  // ---------------------------------------------------------------------
  // media
  // ---------------------------------------------------------------------

  router.get('/media/:id', requirePermission(deps, PERM_READ), async (req, res) => {
    const id = idParam(req, res);
    if (!id || !deps.db) return;
    const s = req.staffSession!;
    const [row] = await deps.db
      .select({
        storageKey: smsMedia.storageKey,
        contentType: smsMedia.contentType,
        firmId: smsMedia.firmId,
        conversationId: smsMessages.conversationId,
      })
      .from(smsMedia)
      .innerJoin(smsMessages, eq(smsMessages.id, smsMedia.messageId))
      .where(eq(smsMedia.id, id))
      .limit(1);
    if (!row || row.firmId !== s.firmId || !row.storageKey) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const conv = await loadVisible(req, res, row.conversationId);
    if (!conv) return;
    let storage = deps.storage ?? null;
    if (!storage) {
      try {
        storage = buildStorageClient(process.env);
      } catch {
        storage = null;
      }
    }
    if (!storage) {
      res.status(503).json({ error: 'storage_unavailable' });
      return;
    }
    try {
      const got = await storage.get(row.storageKey);
      res.setHeader('Content-Type', row.contentType ?? 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Content-Disposition', 'inline');
      got.body.pipe(res);
    } catch (err) {
      logger.warn({ err, mediaId: id }, 'sms media read failed');
      res.status(404).json({ error: 'not_found' });
    }
  });

  // ---------------------------------------------------------------------
  // templates
  // ---------------------------------------------------------------------

  router.get('/templates', requirePermission(deps, PERM_READ), async (req, res) => {
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const s = req.staffSession!;
    const rows = await deps.db
      .select()
      .from(smsTemplates)
      .where(
        and(
          eq(smsTemplates.firmId, s.firmId),
          eq(smsTemplates.status, 'ACTIVE'),
          or(eq(smsTemplates.scope, 'firm'), eq(smsTemplates.ownerUserId, s.appUserId)),
        ),
      )
      .orderBy(asc(smsTemplates.scope), asc(smsTemplates.name));
    res.json({
      items: rows.map((t) => ({
        id: t.id,
        name: t.name,
        body: t.body,
        scope: t.scope,
        variables: t.variables,
      })),
    });
  });

  async function templateGate(
    req: Request,
    res: Response,
    scope: 'firm' | 'user',
  ): Promise<boolean> {
    if (scope === 'user') return true;
    let allowed = false;
    await requirePermission(deps, PERM_SETTINGS)(
      req,
      { status: () => ({ json: () => undefined }) } as unknown as Response,
      () => {
        allowed = true;
      },
    );
    if (!allowed) res.status(403).json({ error: 'forbidden', required: PERM_SETTINGS });
    return allowed;
  }

  router.post('/templates', requirePermission(deps, PERM_WRITE), async (req, res) => {
    const parsed = TemplateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    if (!deps.db) {
      res.status(503).json({ error: 'db_unavailable' });
      return;
    }
    const s = req.staffSession!;
    if (!(await templateGate(req, res, parsed.data.scope))) return;
    const [row] = await deps.db
      .insert(smsTemplates)
      .values({
        firmId: s.firmId,
        scope: parsed.data.scope,
        ownerUserId: parsed.data.scope === 'user' ? s.appUserId : null,
        name: parsed.data.name,
        body: parsed.data.body,
        variables: extractSmsTemplateVars(parsed.data.body),
      })
      .returning();
    await emitAudit(deps.db, {
      action: 'CREATE',
      entityType: 'sms_template',
      entityId: row!.id,
      actorAppUserId: s.appUserId,
      after: { name: row!.name, scope: row!.scope },
    }).catch(() => undefined);
    res.status(201).json({
      id: row!.id,
      name: row!.name,
      body: row!.body,
      scope: row!.scope,
      variables: row!.variables,
    });
  });

  router.patch('/templates/:id', requirePermission(deps, PERM_WRITE), async (req, res) => {
    const id = idParam(req, res);
    if (!id || !deps.db) return;
    const parsed = TemplateBody.partial().safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
      return;
    }
    const s = req.staffSession!;
    const [t] = await deps.db
      .select()
      .from(smsTemplates)
      .where(and(eq(smsTemplates.id, id), eq(smsTemplates.firmId, s.firmId)))
      .limit(1);
    if (!t) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (t.scope === 'user' && t.ownerUserId !== s.appUserId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (!(await templateGate(req, res, t.scope))) return;
    const body = parsed.data.body ?? t.body;
    await deps.db
      .update(smsTemplates)
      .set({
        name: parsed.data.name ?? t.name,
        body,
        variables: extractSmsTemplateVars(body),
        updatedAt: nowFn(),
      })
      .where(eq(smsTemplates.id, id));
    await emitAudit(deps.db, {
      action: 'UPDATE',
      entityType: 'sms_template',
      entityId: id,
      actorAppUserId: s.appUserId,
      before: { name: t.name },
      after: { name: parsed.data.name ?? t.name },
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  router.delete('/templates/:id', requirePermission(deps, PERM_WRITE), async (req, res) => {
    const id = idParam(req, res);
    if (!id || !deps.db) return;
    const s = req.staffSession!;
    const [t] = await deps.db
      .select()
      .from(smsTemplates)
      .where(and(eq(smsTemplates.id, id), eq(smsTemplates.firmId, s.firmId)))
      .limit(1);
    if (!t) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (t.scope === 'user' && t.ownerUserId !== s.appUserId) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (!(await templateGate(req, res, t.scope))) return;
    await deps.db
      .update(smsTemplates)
      .set({ status: 'ARCHIVED', updatedAt: nowFn() })
      .where(eq(smsTemplates.id, id));
    await emitAudit(deps.db, {
      action: 'ARCHIVE',
      entityType: 'sms_template',
      entityId: id,
      actorAppUserId: s.appUserId,
    }).catch(() => undefined);
    res.json({ ok: true });
  });

  router.post('/templates/:id/render', requirePermission(deps, PERM_READ), async (req, res) => {
    const id = idParam(req, res);
    if (!id || !deps.db) return;
    const s = req.staffSession!;
    const convId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
    const [t] = await deps.db
      .select()
      .from(smsTemplates)
      .where(and(eq(smsTemplates.id, id), eq(smsTemplates.firmId, s.firmId)))
      .limit(1);
    if (!t) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    let vars: Record<string, string | null> = {};
    if (UUID_RE.test(convId)) {
      const conv = await loadVisible(req, res, convId);
      if (!conv) return;
      vars = (await detailView(req, conv)).templateVars;
    }
    res.json(renderSmsTemplate(t.body, vars));
  });

  // ---------------------------------------------------------------------
  // counts + stream
  // ---------------------------------------------------------------------

  // Lines for the new-conversation line picker (settings own the full CRUD).
  router.get('/lines', requirePermission(deps, PERM_READ), async (req, res) => {
    if (!deps.db) {
      res.json({ items: [] });
      return;
    }
    const s = req.staffSession!;
    const rows = await deps.db
      .select({
        id: smsLines.id,
        phoneNumberE164: smsLines.phoneNumberE164,
        label: smsLines.label,
        isDefault: smsLines.isDefault,
        ingest: smsLines.ingest,
      })
      .from(smsLines)
      .where(and(eq(smsLines.firmId, s.firmId), eq(smsLines.status, 'ACTIVE')))
      .orderBy(desc(smsLines.isDefault), asc(smsLines.phoneNumberE164));
    res.json({ items: rows });
  });

  router.get('/unread-count', requirePermission(deps, PERM_READ), async (req, res) => {
    if (!deps.db) {
      res.json({ unread: 0 });
      return;
    }
    const s = req.staffSession!;
    const blocked = await blockedFor(req);
    const conds = [
      eq(smsConversations.firmId, s.firmId),
      eq(smsConversations.status, 'open'),
      sql`${smsConversations.unreadCount} > 0`,
      or(
        isNull(smsConversations.assignedUserId),
        eq(smsConversations.assignedUserId, s.appUserId),
      )!,
    ];
    if (blocked.size > 0) {
      conds.push(
        or(
          isNull(smsConversations.clientId),
          sql`${smsConversations.clientId} NOT IN ${[...blocked]}`,
        )!,
      );
    }
    const [row] = await deps.db
      .select({ c: sql<number>`count(*)::int` })
      .from(smsConversations)
      .where(and(...conds));
    res.json({ unread: Number(row?.c ?? 0) });
  });

  router.get('/stream', requirePermission(deps, PERM_READ), async (req, res) => {
    const s = req.staffSession!;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const redisUrl = deps.redisUrl ?? process.env['REDIS_URL'] ?? null;
    if (!redisUrl) {
      res.write('event: unavailable\ndata: {}\n\n');
      res.end();
      return;
    }
    const blocked = await blockedFor(req);
    const subscriber: Redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    const channel = smsEventChannel(s.firmId);
    subscriber.subscribe(channel).catch((err: unknown) => {
      res.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
    });
    subscriber.on('message', (_chan, msg) => {
      let evt: SmsEvent | null = null;
      try {
        evt = JSON.parse(msg) as SmsEvent;
      } catch {
        return;
      }
      if (evt.clientId && blocked.has(evt.clientId)) return;
      res.write(`event: ${evt.type}\ndata: ${msg}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      void subscriber.quit().catch(() => undefined);
    });
  });

  // ---------------------------------------------------------------------
  // engagement / client surfaces (Phase 9 backend)
  // ---------------------------------------------------------------------

  router.get(
    '/engagements/:id/conversations',
    requirePermission(deps, PERM_READ),
    async (req, res) => {
      const id = idParam(req, res);
      if (!id || !deps.db) return;
      const s = req.staffSession!;
      const [eng] = await deps.db
        .select({ id: engagements.id, clientId: engagements.clientId })
        .from(engagements)
        .innerJoin(clients, eq(clients.id, engagements.clientId))
        .where(and(eq(engagements.id, id), eq(clients.firmId, s.firmId)))
        .limit(1);
      if (!eng || !(await canAccessClient(deps, s.appUserId, s.firmId, eng.clientId))) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const rows = await listSelect(deps.db)
        .where(and(eq(smsConversations.firmId, s.firmId), eq(smsConversations.engagementId, id)))
        .orderBy(desc(smsConversations.lastMessageAt));
      const convIds = rows.map((r) => r.id);
      const recent =
        convIds.length > 0
          ? await deps.db
              .select({
                id: smsMessages.id,
                conversationId: smsMessages.conversationId,
                direction: smsMessages.direction,
                body: smsMessages.body,
                providerStatus: smsMessages.providerStatus,
                createdAt: smsMessages.createdAt,
              })
              .from(smsMessages)
              .where(inArray(smsMessages.conversationId, convIds))
              .orderBy(desc(smsMessages.createdAt))
              .limit(5)
          : [];
      res.json({ conversations: rows.map(rowView), recent: recent.reverse() });
    },
  );

  router.get('/clients/:id/conversations', requirePermission(deps, PERM_READ), async (req, res) => {
    const id = idParam(req, res);
    if (!id || !deps.db) return;
    const s = req.staffSession!;
    if (!(await canAccessClient(deps, s.appUserId, s.firmId, id))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const rows = await listSelect(deps.db)
      .where(and(eq(smsConversations.firmId, s.firmId), eq(smsConversations.clientId, id)))
      .orderBy(desc(smsConversations.lastMessageAt));
    res.json({ items: rows.map(rowView) });
  });

  return router;
}
