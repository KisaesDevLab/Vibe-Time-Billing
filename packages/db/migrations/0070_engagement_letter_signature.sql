-- =====================================================================
-- Migration: 0070_engagement_letter_signature.sql  (Stage CP8)
--
-- Engagement letter signature capture (Build Plan §2.11).
--
-- Adds optional columns to persist the client's drawn signature as an
-- inline SVG path. We store SVG (not raster) so the signature stays
-- crisp at any DPI and can be embedded directly in the rendered letter
-- HTML/PDF without an additional storage round-trip.
--
-- signature_svg holds the raw <svg>...</svg> markup; the server
-- sanitizes input to allow only <svg>/<path>/<polyline>/<line> with a
-- bounded attribute set. Typical payload is ~2-5 KB.
--
-- signed_full_name is the typed name the client types alongside the
-- signature pad — provides a fallback when the drawing is illegible.
-- =====================================================================

ALTER TABLE vibetb.engagement_letter
  ADD COLUMN IF NOT EXISTS signature_svg text,
  ADD COLUMN IF NOT EXISTS signed_full_name text;
