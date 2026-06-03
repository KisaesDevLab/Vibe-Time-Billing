// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin → Knowledge Base. List, create, edit, and archive support
// articles. Gated on the `kb:manage` permission.

import { useEffect, useState } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';
import { usePermission } from '../../auth-context';

interface Category {
  id: string;
  slug: string;
  title: string;
}
interface ManageArticle {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  categoryId: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  isSystem: boolean;
}
interface FullArticle extends ManageArticle {
  bodyMarkdown: string;
  tags: string[];
}

interface Draft {
  id: string | null; // null = new
  slug: string;
  title: string;
  summary: string;
  categorySlug: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  bodyMarkdown: string;
}

const EMPTY: Draft = {
  id: null,
  slug: '',
  title: '',
  summary: '',
  categorySlug: '',
  status: 'PUBLISHED',
  bodyMarkdown: '',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: tokens.space.sm,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
};

export function KnowledgeBaseAdminPage(): JSX.Element {
  const canManage = usePermission('kb:manage');
  const [articles, setArticles] = useState<ManageArticle[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    const [a, c] = await Promise.all([
      api<{ articles: ManageArticle[] }>('/api/staff/help/manage/articles'),
      api<{ categories: Category[] }>('/api/staff/help/categories'),
    ]);
    setArticles(a.articles);
    setCategories(c.categories);
  }

  useEffect(() => {
    if (!canManage) return;
    void load().catch((err) => setError(err instanceof Error ? err.message : 'load failed'));
  }, [canManage]);

  if (!canManage) {
    return (
      <Card>
        <p style={{ fontSize: 13 }}>You don&apos;t have permission to manage the knowledge base.</p>
      </Card>
    );
  }

  const catById = new Map(categories.map((c) => [c.id, c]));

  async function edit(id: string): Promise<void> {
    const a = articles.find((x) => x.id === id);
    if (!a) return;
    const r = await api<{ article: FullArticle }>(
      `/api/staff/help/articles/${encodeURIComponent(a.slug)}`,
    );
    setDraft({
      id: a.id,
      slug: a.slug,
      title: r.article.title,
      summary: r.article.summary ?? '',
      categorySlug: a.categoryId ? (catById.get(a.categoryId)?.slug ?? '') : '',
      status: r.article.status,
      bodyMarkdown: r.article.bodyMarkdown,
    });
  }

  async function save(): Promise<void> {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      if (draft.id) {
        await api(`/api/staff/help/articles/${draft.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: draft.title,
            summary: draft.summary || undefined,
            categorySlug: draft.categorySlug || null,
            status: draft.status,
            bodyMarkdown: draft.bodyMarkdown,
          }),
        });
      } else {
        await api('/api/staff/help/articles', {
          method: 'POST',
          body: JSON.stringify({
            slug: draft.slug,
            title: draft.title,
            summary: draft.summary || undefined,
            categorySlug: draft.categorySlug || null,
            status: draft.status,
            bodyMarkdown: draft.bodyMarkdown,
          }),
        });
      }
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  }

  async function archive(id: string): Promise<void> {
    if (!window.confirm('Archive this article? It will be hidden from staff and the AI assistant.'))
      return;
    await api(`/api/staff/help/articles/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await load();
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Knowledge Base</h2>
          <Button onClick={() => setDraft({ ...EMPTY })}>New article</Button>
        </div>
        {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
      </Card>

      {draft && (
        <Card>
          <h3 style={{ marginTop: 0, fontSize: 15 }}>
            {draft.id ? 'Edit article' : 'New article'}
          </h3>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Input
                label="Title"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Slug
                </div>
                <input
                  style={inputStyle}
                  value={draft.slug}
                  disabled={!!draft.id}
                  placeholder="kebab-case-slug"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                    })
                  }
                />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Category
                </div>
                <select
                  style={inputStyle}
                  value={draft.categorySlug}
                  onChange={(e) => setDraft({ ...draft, categorySlug: e.target.value })}
                >
                  <option value="">— none —</option>
                  {categories.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Status
                </div>
                <select
                  style={inputStyle}
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({ ...draft, status: e.target.value as Draft['status'] })
                  }
                >
                  <option value="PUBLISHED">Published</option>
                  <option value="DRAFT">Draft</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </div>
            </div>
            <Input
              label="Summary"
              value={draft.summary}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            />
            <div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
                Body (Markdown)
              </div>
              <textarea
                value={draft.bodyMarkdown}
                onChange={(e) => setDraft({ ...draft, bodyMarkdown: e.target.value })}
                rows={16}
                style={{ ...inputStyle, fontFamily: tokens.font.mono, lineHeight: 1.5 }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                onClick={() => void save()}
                disabled={busy || !draft.title || !draft.slug || !draft.bodyMarkdown}
              >
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <div style={{ display: 'grid', gap: 4 }}>
          {articles.map((a) => (
            <div
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 4px',
                borderBottom: `1px solid ${tokens.color.border}`,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>{a.title}</div>
                <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
                  {a.categoryId ? (catById.get(a.categoryId)?.title ?? '—') : '—'} · {a.slug}
                </div>
              </div>
              <Pill
                tone={
                  a.status === 'PUBLISHED'
                    ? 'success'
                    : a.status === 'DRAFT'
                      ? 'warning'
                      : 'neutral'
                }
              >
                {a.status}
              </Pill>
              {a.isSystem && <Pill tone="neutral">system</Pill>}
              <Button variant="secondary" onClick={() => void edit(a.id)}>
                Edit
              </Button>
              {a.status !== 'ARCHIVED' && (
                <Button variant="ghost" onClick={() => void archive(a.id)}>
                  Archive
                </Button>
              )}
            </div>
          ))}
          {articles.length === 0 && (
            <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>No articles yet.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
