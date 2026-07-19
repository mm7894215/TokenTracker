-- User device renames kept reverting to the client default name: every device
-- token issuance (12h dashboard rotation, CLI device-flow login) refreshed
-- device_name from the client-computed default. Record "the user renamed this
-- device" so those keep-fresh writes can skip protected rows.

ALTER TABLE public.tokentracker_devices
  ADD COLUMN IF NOT EXISTS name_customized boolean NOT NULL DEFAULT false;

-- Captured by the rename endpoint on a row's FIRST rename: the pre-rename
-- client-default name. Legacy adoption (token-issue / device-flow-poll)
-- matches on it as a fallback, so renaming a machine_id-less row does not
-- make it un-adoptable (which would split off a fresh device on the next
-- client-upgrade login). NULL for rows renamed before this migration shipped
-- — their original default is unrecoverable, matching today's behavior.
ALTER TABLE public.tokentracker_devices
  ADD COLUMN IF NOT EXISTS default_device_name text;

-- One-time backfill, scoped to ACTIVE rows: revoked devices never receive
-- keep-fresh writes (every writer filters revoked_at IS NULL), so flagging
-- them would only blur the column's meaning. Any active name that does not
-- look like a client default ("Token Tracker", "Token Tracker (dashboard)
-- #hex8", "TokenTracker CLI (<clientInfo>) #hex8", with or without the
-- legacy-era suffixes) must have come from the rename endpoint. Pattern
-- matching is acceptable here as a migration-time heuristic; runtime
-- protection relies only on the flag.
UPDATE public.tokentracker_devices
SET name_customized = true
WHERE revoked_at IS NULL
  AND device_name !~ '^Token Tracker( \(dashboard\))?( #[0-9a-fA-F]{8})?$'
  AND device_name !~ '^TokenTracker CLI( \(.*\))?( #[0-9a-fA-F]{8})?$';
