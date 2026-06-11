// SPDX-License-Identifier: Elastic-2.0
//
// Client portal help center. Two tabs:
//   • Help articles — browse client-visible KB categories/articles + search.
//   • Ask AI — KB-grounded support chat (shown only when AI is enabled).
// All content is audience-scoped server-side to client-visible articles.

import { useEffect, useRef, useState, type JSX } from 'react';

import { Button, Card, EmptyState, Pill, SectionHeading, tokens } from '@vibe/ui';

import { api } from '../api-client';

interface Category {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  articleCount: number;
}
interface ArticleSummary {
  slug: string;
  title: string;
  summary: string | null;
  categoryId: string | null;
}
interface FullArticle {
  slug: string;
  title: string;
  summary: string | null;
  bodyMarkdown: string;
}
interface Source {
  slug: string;
  title: string;
}
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
}

export function HelpPage(): JSX.Element {
  const [tab, setTab] = useState<'browse' | 'ask'>('browse');
  const [aiEnabled, setAiEnabled] = useState(false);

  // Browse state.
  const [categories, setCategories] = useState<Category[]>([]);
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [activeCategory, setActiveCategory] = useState<Category | null>(null);
  const [search, setSearch] = useState('');
  const [article, setArticle] = useState<FullArticle | null>(null);
  const [loading, setLoading] = useState(false);

  // Chat state.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api<{ enabled: boolean }>('/api/portal/ai/status')
      .then((r) => setAiEnabled(r.enabled))
      .catch(() => setAiEnabled(false));
    void loadCategories();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  async function loadCategories(): Promise<void> {
    try {
      const r = await api<{ categories: Category[] }>('/api/portal/help/categories');
      setCategories(r.categories ?? []);
    } catch {
      setCategories([]);
    }
  }

  async function openCategory(cat: Category): Promise<void> {
    setActiveCategory(cat);
    setArticle(null);
    setSearch('');
    setLoading(true);
    try {
      const r = await api<{ articles: ArticleSummary[] }>(
        `/api/portal/help/articles?category=${encodeURIComponent(cat.slug)}`,
      );
      setArticles(r.articles ?? []);
    } finally {
      setLoading(false);
    }
  }

  async function runSearch(q: string): Promise<void> {
    setSearch(q);
    setActiveCategory(null);
    setArticle(null);
    if (!q.trim()) {
      setArticles([]);
      return;
    }
    setLoading(true);
    try {
      const r = await api<{ articles: ArticleSummary[] }>(
        `/api/portal/help/articles?q=${encodeURIComponent(q)}`,
      );
      setArticles(r.articles ?? []);
    } finally {
      setLoading(false);
    }
  }

  async function openArticle(slug: string): Promise<void> {
    setTab('browse');
    setLoading(true);
    try {
      const r = await api<{ article: FullArticle }>(
        `/api/portal/help/articles/${encodeURIComponent(slug)}`,
      );
      setArticle(r.article);
    } catch {
      setError('Could not open that article.');
    } finally {
      setLoading(false);
    }
  }

  function backToList(): void {
    setArticle(null);
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setSending(true);
    try {
      const r = await api<{ message: string; sources: Source[] }>('/api/portal/ai/chat', {
        method: 'POST',
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: r.message, sources: r.sources },
      ]);
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(
        status === 402
          ? 'The AI assistant is temporarily unavailable (usage limit reached). Please message your firm.'
          : 'Sorry — the assistant could not respond. Please try again or message your firm.',
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <SectionHeading
        title="Help"
        description="Browse how-to articles or ask the assistant a question about using your portal."
      />

      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant={tab === 'browse' ? 'primary' : 'ghost'} onClick={() => setTab('browse')}>
          Help articles
        </Button>
        {aiEnabled && (
          <Button variant={tab === 'ask' ? 'primary' : 'ghost'} onClick={() => setTab('ask')}>
            Ask AI
          </Button>
        )}
      </div>

      {tab === 'browse' && (
        <BrowseTab
          categories={categories}
          articles={articles}
          activeCategory={activeCategory}
          search={search}
          article={article}
          loading={loading}
          onSearch={(q) => void runSearch(q)}
          onOpenCategory={(c) => void openCategory(c)}
          onOpenArticle={(s) => void openArticle(s)}
          onBack={backToList}
          onReset={() => {
            setActiveCategory(null);
            setArticles([]);
            setSearch('');
            setArticle(null);
          }}
        />
      )}

      {tab === 'ask' && aiEnabled && (
        <Card title="Ask the assistant">
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
            Answers come from your firm’s help articles. For account-specific questions, message
            your firm.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {messages.length === 0 && (
              <div style={{ fontSize: 13, color: tokens.color.textMuted }}>
                Try “How do I pay an invoice?” or “How do I upload documents?”
              </div>
            )}
            {messages.map((m, i) => (
              <ChatBubble key={i} message={m} onOpenArticle={(s) => void openArticle(s)} />
            ))}
            {sending && (
              <div style={{ fontSize: 13, color: tokens.color.textMuted }}>Thinking…</div>
            )}
            <div ref={chatEndRef} />
          </div>
          {error && (
            <p style={{ color: tokens.color.danger, fontSize: 12, marginBottom: 0 }}>{error}</p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Ask a question…"
              style={{
                flex: 1,
                padding: '8px 10px',
                fontSize: 13,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                background: tokens.color.surface,
                color: tokens.color.text,
              }}
            />
            <Button onClick={() => void send()} disabled={sending || !input.trim()}>
              Send
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function BrowseTab(props: {
  categories: Category[];
  articles: ArticleSummary[];
  activeCategory: Category | null;
  search: string;
  article: FullArticle | null;
  loading: boolean;
  onSearch: (q: string) => void;
  onOpenCategory: (c: Category) => void;
  onOpenArticle: (slug: string) => void;
  onBack: () => void;
  onReset: () => void;
}): JSX.Element {
  const {
    categories,
    articles,
    activeCategory,
    search,
    article,
    loading,
    onSearch,
    onOpenCategory,
    onOpenArticle,
    onBack,
    onReset,
  } = props;

  if (article) {
    return (
      <Card>
        <Button variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <h2 style={{ marginTop: 12, marginBottom: 4 }}>{article.title}</h2>
        <Markdown source={article.bodyMarkdown} />
      </Card>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.md }}>
      <input
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        placeholder="Search help…"
        style={{
          padding: '8px 10px',
          fontSize: 13,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          background: tokens.color.surface,
          color: tokens.color.text,
        }}
      />

      {loading && <div style={{ fontSize: 13, color: tokens.color.textMuted }}>Loading…</div>}

      {/* Category grid (default view) */}
      {!search && !activeCategory && (
        <>
          {categories.length === 0 ? (
            <EmptyState icon="📚" title="No help articles yet" body="Check back soon." />
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: tokens.space.md,
              }}
            >
              {categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onOpenCategory(c)}
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    padding: tokens.space.md,
                    border: `1px solid ${tokens.color.border}`,
                    borderRadius: tokens.radius.md,
                    background: tokens.color.surface,
                    color: tokens.color.text,
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{c.title}</div>
                  {c.description && (
                    <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 4 }}>
                      {c.description}
                    </div>
                  )}
                  <div style={{ marginTop: 8 }}>
                    <Pill tone="neutral">{c.articleCount} articles</Pill>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Article list (category or search results) */}
      {(activeCategory || search) && (
        <Card
          title={activeCategory ? activeCategory.title : `Search: “${search}”`}
          action={
            <Button variant="ghost" onClick={onReset}>
              All topics
            </Button>
          }
        >
          {articles.length === 0 && !loading ? (
            <EmptyState
              icon="🔍"
              title="Nothing found"
              body="Try different words or browse topics."
            />
          ) : (
            <div style={{ display: 'grid', gap: 2 }}>
              {articles.map((a) => (
                <button
                  key={a.slug}
                  onClick={() => onOpenArticle(a.slug)}
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    padding: '8px 4px',
                    border: 'none',
                    borderBottom: `1px solid ${tokens.color.border}`,
                    background: 'transparent',
                    color: tokens.color.text,
                  }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>{a.title}</div>
                  {a.summary && (
                    <div style={{ fontSize: 12, color: tokens.color.textMuted }}>{a.summary}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function ChatBubble({
  message,
  onOpenArticle,
}: {
  message: ChatMessage;
  onOpenArticle: (slug: string) => void;
}): JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '85%',
          padding: '8px 12px',
          borderRadius: tokens.radius.md,
          background: isUser ? tokens.color.accent : tokens.color.bg,
          border: isUser ? 'none' : `1px solid ${tokens.color.border}`,
          color: isUser ? '#fff' : tokens.color.text,
          fontSize: 13.5,
          lineHeight: 1.5,
        }}
      >
        {isUser ? message.content : <Markdown source={message.content} />}
        {message.sources && message.sources.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {message.sources.map((s) => (
              <button
                key={s.slug}
                onClick={() => onOpenArticle(s.slug)}
                style={{
                  cursor: 'pointer',
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: 999,
                  padding: '2px 8px',
                  fontSize: 11,
                  background: tokens.color.surface,
                  color: tokens.color.text,
                }}
              >
                📄 {s.title}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Minimal Markdown renderer — handles the subset the KB uses: ATX headings,
// unordered lists, paragraphs, and inline **bold**, `code`, and [links](url).
function Markdown({ source }: { source: string }): JSX.Element {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: JSX.Element[] = [];
  let list: string[] = [];
  let key = 0;

  const flushList = (): void => {
    if (list.length === 0) return;
    const items = [...list];
    blocks.push(
      <ul key={key++} style={{ margin: '4px 0', paddingLeft: 20 }}>
        {items.map((it, i) => (
          <li key={i} style={{ marginBottom: 2 }}>
            {inline(it)}
          </li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = h[1]!.length;
      const sizes = [0, 20, 17, 15, 14];
      blocks.push(
        <div key={key++} style={{ fontWeight: 700, fontSize: sizes[level], margin: '10px 0 4px' }}>
          {inline(h[2]!)}
        </div>,
      );
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      list.push(line.replace(/^[-*]\s+/, ''));
      continue;
    }
    flushList();
    blocks.push(
      <p key={key++} style={{ margin: '4px 0' }}>
        {inline(line)}
      </p>,
    );
  }
  flushList();
  return <div>{blocks}</div>;
}

// Inline formatting: **bold**, `code`, [text](url). Order matters; links last.
function inline(text: string): (string | JSX.Element)[] {
  const out: (string | JSX.Element)[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      out.push(<strong key={key++}>{m[2]}</strong>);
    } else if (m[4] !== undefined) {
      out.push(
        <code
          key={key++}
          style={{ fontFamily: tokens.font.mono, fontSize: '0.92em', opacity: 0.9 }}
        >
          {m[4]}
        </code>,
      );
    } else if (m[6] !== undefined && m[7] !== undefined) {
      const href = m[7];
      const safe = /^(https?:|\/)/i.test(href) ? href : '#';
      out.push(
        <a key={key++} href={safe} target="_blank" rel="noreferrer">
          {m[6]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
