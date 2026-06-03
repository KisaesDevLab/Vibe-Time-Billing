-- =====================================================================
-- Migration: 0096_knowledge_base.sql
--
-- Support knowledge base. Firm-scoped so a firm's edits stay local;
-- product/support articles are seeded at app boot with is_system=true
-- (editable but flagged). The in-app AI support chat retrieves PUBLISHED
-- articles to ground its answers.
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE kb_article_status AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS vibetb.kb_category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_category_firm_slug_uk UNIQUE (firm_id, slug)
);

CREATE TABLE IF NOT EXISTS vibetb.kb_article (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES vibetb.firm(id) ON DELETE CASCADE,
  category_id uuid REFERENCES vibetb.kb_category(id) ON DELETE SET NULL,
  slug text NOT NULL,
  title text NOT NULL,
  summary text,
  body_markdown text NOT NULL,
  tags text[],
  status kb_article_status NOT NULL DEFAULT 'PUBLISHED',
  is_system boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  updated_by_id uuid REFERENCES vibetb.app_user(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_article_firm_slug_uk UNIQUE (firm_id, slug)
);

CREATE INDEX IF NOT EXISTS kb_article_firm_category_idx
  ON vibetb.kb_article (firm_id, category_id);
CREATE INDEX IF NOT EXISTS kb_article_firm_status_idx
  ON vibetb.kb_article (firm_id, status);
