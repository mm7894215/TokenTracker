-- Enforce at most one active device per (user_id, platform, device_name).
--
-- Motivation: the cloud-sync flow was creating a fresh tokentracker_devices
-- row on every call to tokentracker-device-token-issue (localStorage is
-- isolated across Safari / Chrome / WKWebView; each environment asked for a
-- new token). Same logical device ended up splayed across many device_ids
-- and the leaderboard-refresh aggregate double-counted. Cloud aggregation
-- now dedupes with MAX(total_tokens) per (user, source, model, hour_start),
-- and tokentracker-device-token-issue now reuses an existing active device
-- via ON CONFLICT DO NOTHING on this partial unique index.
--
-- Idempotent.

-- 1) Pick the oldest active device per (user_id, platform, device_name) and
--    revoke the rest so the partial index can be created.
UPDATE tokentracker_devices d
   SET revoked_at = NOW()
 WHERE revoked_at IS NULL
   AND id NOT IN (
     SELECT DISTINCT ON (user_id, platform, device_name) id
       FROM tokentracker_devices
      WHERE revoked_at IS NULL
      ORDER BY user_id, platform, device_name, created_at ASC
   );

-- 2) Partial unique index keyed on the live subset. Tokens are still allowed
--    to rotate (multiple rows in tokentracker_device_tokens per device); this
--    only constrains the device identity row.
CREATE UNIQUE INDEX IF NOT EXISTS tokentracker_devices_active_unique
  ON tokentracker_devices (user_id, platform, device_name)
  WHERE revoked_at IS NULL;
