-- Down: 0168_public_booking.sql
DROP TABLE IF EXISTS vibetb.booking_request;
DROP TABLE IF EXISTS vibetb.public_booking_link_notify;
DROP TABLE IF EXISTS vibetb.public_booking_link_approver;
DROP TABLE IF EXISTS vibetb.public_booking_availability;
ALTER TABLE vibetb.staff_public_booking_link
  DROP COLUMN IF EXISTS hold_expiry_hours,
  DROP COLUMN IF EXISTS slot_increment_minutes,
  DROP COLUMN IF EXISTS min_notice_hours,
  DROP COLUMN IF EXISTS buffer_before_minutes,
  DROP COLUMN IF EXISTS buffer_after_minutes,
  DROP COLUMN IF EXISTS default_duration_minutes,
  DROP COLUMN IF EXISTS require_captcha,
  DROP COLUMN IF EXISTS daily_cap;
