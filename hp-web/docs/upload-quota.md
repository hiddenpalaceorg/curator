# Pending upload quota

The default limit is 10 TB (10,000,000,000,000 bytes). Assets referenced by the
approved library do not count. Reservations are shared across processes and
held before accepting bytes; crashes retain their charge and exclusive digest
lease. Concurrent requests for one digest return retryable 429 while unrelated
uploads can proceed. Stale-file cleanup uses the same lease and runs even when
the quota is full. Coexisting partial and final copies are both inventoried
and counted; S3 writes reserve both copies during upload. Local writes use an
atomic rename. The existing local free-space reserve is also enforced.

Deployment requires a one-time inventory to include pre-existing or orphaned
objects, not just current submission records:

1. Stop old upload workers and asset import jobs.
2. Apply `db/migrations/013-upload-quota.sql` and deploy the new code.
3. From hp-web, with the production database/store environment, run
   `npx tsx scripts/initialize-upload-quota.ts --initialize`.
4. Resume workers. Uploads fail closed until inventory completes.

Preserve and back up `upload_quota` and `upload_quota_config` with other user
data across corpus reloads. Changing stores requires a new verified inventory;
the route refuses a mismatched store identity. Never reset these tables to
reclaim space: first verify and remove unwanted storage with uploads stopped.
No automated deletion of finalized assets is performed. Abandoned/crashed
reservations can overcount and keep that digest busy until reconciled by an
operator; this is fail-closed. Stop all upload workers before inspecting and
reconciling a crashed lease. Never clear active leases while writers can run.
