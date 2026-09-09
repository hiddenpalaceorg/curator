# Private upload staging

Depends on the pending-upload quota change and its latest migration 013.
That inventory separates verified final bytes from unverified staging; new
reservations count every private staging copy. Deploy the latest quota
revision, not an earlier version that lacked the final-byte counter.

New clients send a random 32-hex `X-Upload-Token` header, unchanged across one
asset's chunks. Keep it private. Offsets and offset-zero restarts affect only
that capability's staging file. The server's digest lease serializes writes,
hashing, finalization, quota reconciliation and stale cleanup across workers.

A client restart can create a new capability without taking over old work.
At most 32 retained partial sessions are allowed per digest; stale sessions
expire after 24 hours. All partial copies consume pending quota, including
copies of an already approved object. Verified approved final bytes remain
exempt. S3 writes reserve room for the temporary final copy as well.

Release updated clients before enabling the new upload route. Old clients
can still send a complete asset in one request, but tokenless partial/resume
requests now return 400. The old shared `<sha>.part` files are inventoried and
reaped but never adopted by an anonymous new upload. Source content hashes,
stored/exists responses and ordinary 409/429 behavior remain unchanged.

Do not log or publish upload capabilities. No production changes are included.
