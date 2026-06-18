-- Down: 0169_public_booking_location.sql
ALTER TABLE vibetb.booking_request
  DROP COLUMN IF EXISTS location,
  DROP COLUMN IF EXISTS location_option_id,
  DROP COLUMN IF EXISTS location_detail;
ALTER TABLE vibetb.public_booking_availability
  DROP COLUMN IF EXISTS location_types;
