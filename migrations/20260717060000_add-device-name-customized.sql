-- User device renames kept reverting to the client default name: every device
-- token issuance (12h dashboard rotation, CLI device-flow login) refreshed
-- device_name from the client-computed default. Record "the user renamed this
-- device" so those keep-fresh writes can skip protected rows.

ALTER TABLE public.tokentracker_devices
  ADD COLUMN IF NOT EXISTS name_customized boolean NOT NULL DEFAULT false;

-- One-time backfill: any active name that does not look like a client default
-- ("Token Tracker", "Token Tracker (dashboard) #hex8", "TokenTracker CLI
-- (<clientInfo>) #hex8", with or without the legacy-era suffixes) must have
-- come from the rename endpoint. Pattern matching is acceptable here as a
-- migration-time heuristic; runtime protection relies only on the flag.
UPDATE public.tokentracker_devices
SET name_customized = true
WHERE device_name !~ '^Token Tracker( \(dashboard\))?( #[0-9a-fA-F]{8})?$'
  AND device_name !~ '^TokenTracker CLI( \(.*\))?( #[0-9a-fA-F]{8})?$';
