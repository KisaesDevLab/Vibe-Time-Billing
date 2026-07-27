ALTER TABLE vibetb.client
  DROP COLUMN IF EXISTS entity_type;

DROP TYPE IF EXISTS vibetb.client_entity_type;
