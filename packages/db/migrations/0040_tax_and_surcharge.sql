-- =====================================================================
-- Migration: 0040_tax_and_surcharge.sql
--
-- v2 Part 2 — sales tax + per-engagement invoice surcharge.
-- Step 1 of 2: extend the invoice_line_item_kind enum. Kept separate
-- from the table alters in 0041 because `ALTER TYPE ... ADD VALUE`
-- requires the new value to be committed before any DML/DDL in the
-- same transaction can reference it.
-- =====================================================================

ALTER TYPE invoice_line_item_kind ADD VALUE IF NOT EXISTS 'SALES_TAX';
ALTER TYPE invoice_line_item_kind ADD VALUE IF NOT EXISTS 'SURCHARGE';
