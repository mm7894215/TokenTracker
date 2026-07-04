-- Device -> machine cluster map for cross-device aggregation (issue #187 follow-up,
-- 2026-06-17). Backs account_usage_grouped's "within-cluster max, cross-cluster
-- sum" machine-level branch: same physical machine's device-id splits share a
-- cluster (deduped to max, no inflation); genuinely distinct machines get
-- separate clusters (summed, no lost multi-machine usage).
--
-- WHY a precomputed table, not machine_id: tokentracker_devices.machine_id is
-- ~80% NULL (old clients didn't emit it; containers / ioreg failures fall back to
-- randomUUID). So clustering is by VALUE CONSISTENCY of the hourly snapshots:
-- two devices of the same user are the SAME machine when their overlapping
-- (hour,source,model) buckets either have equal values (replay) OR one covers the
-- other (a CLI + dashboard reading the same logs out of sync = subset). Encoded
-- as: the smaller side's "exceeds" mass over the overlap is < 5% of its total.
-- Genuinely concurrent independent machines exceed each other in BOTH directions.
--
-- Only devices that land in a multi-device same-machine cluster are stored; a
-- device absent from this table clusters as itself (the RPC COALESCEs to
-- device_id), so single-device / lone-device users sum as one cluster.
--
-- 2026-06-17 NOTE: this build UNIONs tt_restore_safety_20260617 into the source
-- rows. That table holds the survivor rows deleted by the restore of the
-- over-aggressive merge cleanup; without it, a same-machine pair whose survivor
-- was emptied by the value-match restore would look non-overlapping and split
-- into two clusters (-> wrongly summed). Once sync has repopulated those buckets
-- on the live devices, a future rebuild can drop the safety UNION and run on
-- tokentracker_hourly alone.
--
-- Leaderboard divergence (intentional): leaderboard_usage_grouped keeps the
-- coarser per-(user,source,model,hour) DISTINCT-max (no cluster join), because
-- the 'total' period DISTINCT-dedupes the ENTIRE history in one pass and adding
-- the cluster sort column + join pushes it past the edge's 30s budget (502s in
-- testing; the un-clustered version runs ~13s). The cost: the ~11 genuinely
-- multi-machine users are slightly under-counted on the PUBLIC ranking (a few
-- hundred M to ~1B each, negligible against B-scale leaderboard totals), while
-- they remain EXACT in their own account view. account-source-parity only
-- asserts the cursor source list, which stays identical, so it still passes.
--
-- Rebuild: DROP TABLE tokentracker_device_machine; then re-run this.

DROP TABLE IF EXISTS tokentracker_device_machine;

CREATE TABLE tokentracker_device_machine AS
WITH RECURSIVE
cd AS (SELECT id, user_id FROM tokentracker_devices WHERE revoked_at IS NULL),
mu AS (SELECT user_id FROM cd GROUP BY user_id HAVING count(*) >= 2),
bd AS (
  SELECT cd.user_id, h.device_id, h.hour_start, h.source, h.model, h.total_tokens::bigint tt
  FROM tokentracker_hourly h JOIN cd ON cd.id = h.device_id
  WHERE h.source <> 'cursor' AND cd.user_id IN (SELECT user_id FROM mu)
  UNION ALL
  SELECT cd.user_id, s.device_id, s.hour_start, s.source, s.model, s.total_tokens::bigint
  FROM tt_restore_safety_20260617 s JOIN cd ON cd.id = s.device_id WHERE s.source <> 'cursor'
),
po AS (
  SELECT a.device_id da, b.device_id db,
    SUM(GREATEST(a.tt - b.tt, 0)) a_exc, SUM(GREATEST(b.tt - a.tt, 0)) b_exc,
    SUM(a.tt) a_ov, SUM(b.tt) b_ov
  FROM bd a JOIN bd b
    ON a.user_id = b.user_id AND a.hour_start = b.hour_start
   AND a.source = b.source AND a.model = b.model AND a.device_id < b.device_id
  GROUP BY a.device_id, b.device_id
),
sm AS (
  SELECT da, db FROM po
  WHERE GREATEST(a_ov, b_ov) > 10000000
    AND LEAST(a_exc, b_exc)::numeric / NULLIF(LEAST(a_ov, b_ov), 0) < 0.05
),
edges AS (SELECT da a, db b FROM sm UNION SELECT db, da FROM sm),
reach(src, dst) AS (
  SELECT a, a FROM edges
  UNION SELECT a, b FROM edges
  UNION SELECT r.src, e.b FROM reach r JOIN edges e ON e.a = r.dst
)
SELECT src AS device_id, min(dst::text) AS machine_cluster_id
FROM reach GROUP BY src;

ALTER TABLE tokentracker_device_machine ADD PRIMARY KEY (device_id);

-- Internal table: only account_usage_grouped (service-role) reads it, only this
-- ops script (project_admin) writes it. RLS on + zero policy + no browser-role
-- grants, matching every other internal table. CREATE TABLE AS does NOT inherit
-- RLS, so a rebuild without these lines re-exposes the table to anon read/write
-- (the 2026-07-04 gap that let anon skew cross-device aggregates). Do not remove.
ALTER TABLE tokentracker_device_machine ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tokentracker_device_machine FROM anon, authenticated;
