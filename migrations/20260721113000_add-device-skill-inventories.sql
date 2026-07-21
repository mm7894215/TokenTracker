-- Per-device Skills inventory for the signed-in account view.
-- Privacy boundary: rows contain a bounded metadata manifest only (stable key,
-- display name, relative directory, tool ids, scope flags). SKILL.md content,
-- descriptions, prompts, and absolute local paths are never stored.

CREATE TABLE IF NOT EXISTS public.tokentracker_device_skill_inventories (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.tokentracker_devices(id) ON DELETE CASCADE,
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id),
  CONSTRAINT tokentracker_device_skill_inventories_array
    CHECK (jsonb_typeof(skills) = 'array'),
  CONSTRAINT tokentracker_device_skill_inventories_limit
    CHECK (jsonb_array_length(skills) <= 2000)
);

CREATE INDEX IF NOT EXISTS tokentracker_device_skill_inventories_device_idx
  ON public.tokentracker_device_skill_inventories (device_id);

ALTER TABLE public.tokentracker_device_skill_inventories ENABLE ROW LEVEL SECURITY;

-- Browsers must use the authenticated Edge function. Keeping the table off the
-- data API prevents callers from bypassing device ownership checks or reading
-- another user's inventory even if an SDK query is constructed manually.
REVOKE ALL ON public.tokentracker_device_skill_inventories
  FROM PUBLIC, anon, authenticated;
