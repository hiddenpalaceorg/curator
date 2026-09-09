# Pending upload quota

The default limit is 10 TB (10,000,000,000,000 bytes). Assets referenced by the
approved library do not count. Reservations are shared across processes and
held before accepting bytes; crashes retain their charge. Coexisting partial
and final copies are both inventoried and counted. Temporary
copy space is still governed by the existing local free-space reserve.

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
reservations can overcount until reconciled by an operator; this is fail-closed.
