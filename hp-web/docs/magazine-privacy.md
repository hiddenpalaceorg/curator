# Magazine storage access

Magazine pages, source PDFs and crops share the `mag/` backend namespace.
All browser image URLs now pass through the app's association and visibility
checks. The app must retain authenticated access to that backend namespace.

Before enabling private magazines in an existing installation:

1. Disable anonymous bucket/origin access to the entire magazine namespace.
2. Install `deploy/mag-private.conf` in the public asset gateway's server block.
   Prepend the URL path from `ASSET_PUBLIC_BASE` if it is not an origin-only URL.
   Do not install this snippet only in the app's separate port-6800 proxy.
3. Purge existing magazine objects, redirects and `/_next/image` variants
   from gateway/CDN caches. Remove the old image-optimizer caches from both
   app build slots. The new app disables that unused optimizer endpoint.
4. Deploy the app changes. Verify a known private page returns 404 without a
   moderator credential and 200 with one, including its thumbnail URL. Verify
   a non-rejected crop and a public magazine page remain readable anonymously.
5. Verify the old direct gateway URL and the underlying bucket URL for that
   private page return 403/404, including requests with old cache validators.
   Previously cached `/_next/image?url=...` magazine and issue-cover variants
   must also return 404 from the app and after the outer cache purge.

This PR does not change production storage policies or invalidate caches.
Application authorization alone cannot revoke already public direct URLs or
copies downloaded before access was restricted. Deployment verification is
required before considering existing stored pages private.
