-- device_keys is a cache of keys seen in proofs plus an organization deny
-- list, not a key directory: GitHub owns the key-to-identity binding. Record
-- where each row came from so the dashboard never presents a cached or
-- superseded row as a usable key.
ALTER TABLE device_keys ADD COLUMN source TEXT NOT NULL DEFAULT 'github';
UPDATE device_keys SET source = 'legacy-enrollment' WHERE key_id LIKE 'key_%';
