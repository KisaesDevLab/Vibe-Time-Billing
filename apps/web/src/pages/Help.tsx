// SPDX-License-Identifier: Elastic-2.0
//
// Help & Support — a Knowledge Base browser/search and (when AI is
// enabled) a KB-grounded "Ask AI" chat assistant.

import { useEffect, useRef, useState } from 'react';

import { Button, Card, Input, Markdown, Tabs, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { useAiStatus, aiUsable } from '../hooks/useAiStatus';

interface Category {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  articleCount: number;
}
interface ArticleListItem {
  slug: string;
  title: string;
  summary: string | null;
  categoryId: string | null;
}
interface Article {
  slug: string;
  title: string;
  summary: string | null;
  bodyMarkdown: string;
  tags: string[];
}
interface ChatSource {
  slug: string;
  title: string;
}
interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatSource[];
}

export function HelpPage(): JSX.Element {
  const [tab, setTab] = useState<'kb' | 'ai'>('kb');
  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1000 }}>
      <Card>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Help &amp; Support</h2>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, margin: '4px 0 0' }}>
          Browse the knowledge base or ask the AI assistant. Admins can add or edit articles under
          Admin → Knowledge Base.
        </p>
        <div style={{ marginTop: 12 }}>
          <Tabs
            tabs={[
              { key: 'kb', label: 'Knowledge Base' },
              { key: 'ai', label: 'Ask AI' },
            ]}
            active={tab}
            onChange={(k) => setTab(k as 'kb' | 'ai')}
          />
        </div>
      </Card>
      {tab === 'kb' ? <KnowledgeBaseTab /> : <AskAiTab />}
    </div>
  );
}

function KnowledgeBaseTab(): JSX.Element {
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [list, setList] = useState<ArticleListItem[]>([]);
  const [article, setArticle] = useState<Article | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ categories: Category[] }>('/api/staff/help/categories');
        setCategories(r.categories);
        if (r.categories[0]) {
          setActiveCat(r.categories[0].slug);
          await loadCategory(r.categories[0].slug);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Deep link: /help?article=<slug> opens that article directly.
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get('article');
    if (slug) void openArticle(slug).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadCategory(slug: string): Promise<void> {
    setArticle(null);
    setActiveCat(slug);
    const r = await api<{ articles: ArticleListItem[] }>(
      `/api/staff/help/articles?category=${encodeURIComponent(slug)}`,
    );
    setList(r.articles);
  }

  async function runSearch(query: string): Promise<void> {
    setQ(query);
    setArticle(null);
    if (!query.trim()) {
      if (activeCat) await loadCategory(activeCat);
      return;
    }
    setActiveCat(null);
    const r = await api<{ articles: ArticleListItem[] }>(
      `/api/staff/help/articles?q=${encodeURIComponent(query)}`,
    );
    setList(r.articles);
  }

  async function openArticle(slug: string): Promise<void> {
    const r = await api<{ article: Article }>(
      `/api/staff/help/articles/${encodeURIComponent(slug)}`,
    );
    setArticle(r.article);
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: tokens.space.lg }}>
      <Card>
        <Input
          label="Search"
          value={q}
          onChange={(e) => void runSearch(e.target.value)}
          placeholder="Search articles…"
        />
        <div style={{ marginTop: 12, display: 'grid', gap: 2 }}>
          {categories.map((c) => (
            <button
              key={c.slug}
              onClick={() => void loadCategory(c.slug)}
              style={{
                textAlign: 'left',
                border: 'none',
                background: activeCat === c.slug ? tokens.color.surface : 'transparent',
                borderRadius: tokens.radius.sm,
                padding: '6px 8px',
                cursor: 'pointer',
                fontSize: 13,
                color: tokens.color.text,
              }}
            >
              {c.title}{' '}
              <span style={{ color: tokens.color.textMuted, fontSize: 11 }}>
                ({c.articleCount})
              </span>
            </button>
          ))}
        </div>
      </Card>

      <Card>
        {error && <p style={{ color: tokens.color.danger, fontSize: 13 }}>{error}</p>}
        {article ? (
          <div>
            <Button variant="ghost" onClick={() => setArticle(null)}>
              ← Back
            </Button>
            <h2 style={{ fontSize: 20, margin: '8px 0 2px' }}>{article.title}</h2>
            {article.summary && (
              <p style={{ color: tokens.color.textMuted, fontSize: 13, marginTop: 0 }}>
                {article.summary}
              </p>
            )}
            <Markdown source={article.bodyMarkdown} />
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {q.trim() && (
              <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                {list.length} result{list.length === 1 ? '' : 's'} for “{q}”
              </div>
            )}
            {list.length === 0 && (
              <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>No articles here yet.</p>
            )}
            {list.map((a) => (
              <button
                key={a.slug}
                onClick={() => void openArticle(a.slug)}
                style={{
                  textAlign: 'left',
                  border: `1px solid ${tokens.color.border}`,
                  background: tokens.color.surface,
                  borderRadius: tokens.radius.md,
                  padding: tokens.space.sm,
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 14 }}>{a.title}</div>
                {a.summary && (
                  <div style={{ color: tokens.color.textMuted, fontSize: 12.5, marginTop: 2 }}>
                    {a.summary}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function AskAiTab(): JSX.Element {
  const status = useAiStatus();
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openArticle, setOpenArticle] = useState<Article | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs, busy]);

  if (status && !aiUsable(status)) {
    return (
      <Card>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>Ask AI is not enabled</h3>
        <p style={{ fontSize: 13, color: tokens.color.textMuted }}>
          No AI provider is configured for your firm. An administrator can enable a local or cloud
          provider under <strong>Admin → AI</strong>. In the meantime, browse the{' '}
          <strong>Knowledge Base</strong> tab — it answers most questions.
        </p>
      </Card>
    );
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || busy) return;
    const next: ChatMsg[] = [...msgs, { role: 'user', content: text }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ message: string; sources?: ChatSource[] }>('/api/staff/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: next.map((m) => ({ role: m.role, content: m.content })) }),
      });
      setMsgs([...next, { role: 'assistant', content: r.message, sources: r.sources ?? [] }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'chat failed';
      setError(
        msg.includes('402')
          ? 'AI budget exhausted for this month.'
          : 'The assistant could not respond. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function showArticle(slug: string): Promise<void> {
    const r = await api<{ article: Article }>(
      `/api/staff/help/articles/${encodeURIComponent(slug)}`,
    );
    setOpenArticle(r.article);
  }

  if (openArticle) {
    return (
      <Card>
        <Button variant="ghost" onClick={() => setOpenArticle(null)}>
          ← Back to chat
        </Button>
        <h2 style={{ fontSize: 20, margin: '8px 0 2px' }}>{openArticle.title}</h2>
        <Markdown source={openArticle.bodyMarkdown} />
      </Card>
    );
  }

  return (
    <Card>
      <div
        style={{
          display: 'grid',
          gap: 10,
          maxHeight: 460,
          overflowY: 'auto',
          padding: '4px 2px',
        }}
      >
        {msgs.length === 0 && (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>
            Ask anything about using the app — e.g. “How do I write down a pre-bill?” or “How do I
            invite a client to the portal?”. Answers come from your knowledge base.
          </p>
        )}
        {msgs.map((m, i) => (
          <div
            key={i}
            style={{
              justifySelf: m.role === 'user' ? 'end' : 'start',
              maxWidth: '85%',
              background: m.role === 'user' ? tokens.color.accent : tokens.color.surface,
              color: m.role === 'user' ? '#fff' : tokens.color.text,
              border: m.role === 'user' ? 'none' : `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md,
              padding: '8px 12px',
              fontSize: 13.5,
              whiteSpace: 'pre-wrap',
            }}
          >
            {m.content}
            {m.role === 'assistant' && m.sources && m.sources.length > 0 && (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {m.sources.map((s) => (
                  <button
                    key={s.slug}
                    onClick={() => void showArticle(s.slug)}
                    style={{
                      border: `1px solid ${tokens.color.border}`,
                      background: 'transparent',
                      borderRadius: tokens.radius.pill,
                      padding: '2px 8px',
                      fontSize: 11,
                      cursor: 'pointer',
                      color: tokens.color.accent,
                    }}
                  >
                    📄 {s.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div style={{ justifySelf: 'start', color: tokens.color.textMuted, fontSize: 13 }}>
            Thinking…
          </div>
        )}
        <div ref={endRef} />
      </div>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 0 }}>{error}</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        style={{ display: 'flex', gap: 8, marginTop: 10 }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question…"
          style={{
            flex: 1,
            padding: tokens.space.sm,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            fontSize: 13,
          }}
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          Send
        </Button>
      </form>
    </Card>
  );
}
