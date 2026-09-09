//! Web-service client: Find Similar and Submit (with resumable asset-blob
//! uploads). The protocol mirrors the GUIs' native HTTP implementations — a
//! submission POST, a missing-blob check, chunked PUTs that resume on 409 and
//! back off on 429, and an optional moderated accept.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use prism_core::{Event, ProgressObserver};

use crate::progress::LoaderObserver;

/// Upload chunk size — small enough to clear typical proxy body-size limits.
const UPLOAD_CHUNK: usize = 4 * 1024 * 1024;

/// How many asset blobs to upload at once.
const PARALLEL_UPLOADS: usize = 32;

/// Counter id for the upload progress bar. The adapter's counters are all
/// closed by the time the service phase starts, so any id would do.
const UPLOAD_ID: u64 = u64::MAX;

/// Give up after this many consecutive rate-limit waits on one chunk.
const MAX_THROTTLE_RETRIES: u32 = 30;

pub struct Client {
    agent: ureq::Agent,
    base: String,
}

/// What one submission accomplished, for the caller's end-of-run summary.
pub struct SubmitOutcome {
    /// Asset blobs newly confirmed on the server.
    pub uploaded: usize,
    /// Blobs the server wants that the local store does not hold.
    pub unavailable: usize,
    /// Bytes confirmed server-side across the uploaded blobs.
    pub bytes: u64,
    /// Whether the submission was moderation-accepted into the live build.
    pub accepted: bool,
}

impl Client {
    pub fn new(web_url: &str) -> Result<Self> {
        let tls = native_tls::TlsConnector::new().context("initializing TLS")?;
        let agent = ureq::AgentBuilder::new()
            .tls_connector(Arc::new(tls))
            .timeout_connect(Duration::from_secs(10))
            .timeout_read(Duration::from_secs(60))
            .timeout_write(Duration::from_secs(60))
            .build();
        Ok(Client { agent, base: web_url.trim_end_matches('/').to_string() })
    }

    /// Send a request; any HTTP status is returned as `(code, body)` — only
    /// transport failures error.
    fn request(
        &self,
        verb: &str,
        url: &str,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<(u16, String)> {
        let mut req = self.agent.request(verb, url);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        let resp = match body {
            Some(b) => req.send_bytes(b),
            None => req.call(),
        };
        match resp {
            Ok(r) => Ok((r.status(), r.into_string().unwrap_or_default())),
            Err(ureq::Error::Status(code, r)) => Ok((code, r.into_string().unwrap_or_default())),
            Err(e) => bail!("cannot reach service: {e}"),
        }
    }

    /// POST the record to `/api/similarity` and format the neighbor list.
    pub fn similarity(&self, record_json: &str) -> Result<String> {
        let url = format!("{}/api/similarity", self.base);
        let (code, body) = self.request(
            "POST",
            &url,
            &[("Content-Type", "application/json")],
            Some(record_json.as_bytes()),
        )?;
        if !(200..300).contains(&code) {
            bail!("server error {code}: {}", body.trim());
        }
        Ok(prism_core::summary::format_similarity(&body))
    }

    /// Submit a build record, upload whichever of its asset blobs the server
    /// lacks (from `local`: sha256 → blob path), and — with a moderation
    /// token — accept the submission so it replaces the live build.
    pub fn submit(
        &self,
        build_sha: &str,
        record_json: &str,
        nickname: &str,
        local: &HashMap<String, PathBuf>,
        moderation_token: Option<&str>,
        obs: &LoaderObserver,
    ) -> Result<SubmitOutcome> {
        let record: serde_json::Value =
            serde_json::from_str(record_json).context("parsing record JSON")?;
        let body = serde_json::json!({ "nickname": nickname, "record": record });
        let url = format!("{}/api/submissions", self.base);
        let (code, b) = self.request(
            "POST",
            &url,
            &[("Content-Type", "application/json")],
            Some(body.to_string().as_bytes()),
        )?;
        if !(200..300).contains(&code) {
            bail!("server error {code}: {}", b.trim());
        }
        let status = serde_json::from_str::<serde_json::Value>(&b)
            .ok()
            .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from))
            .unwrap_or_else(|| "queued".into());
        obs.on_event(Event::Message(format!("submitted — {status}")));

        let (uploaded, unavailable, bytes) = self.upload_missing_assets(build_sha, local, obs)?;

        let mut accepted = false;
        if let Some(token) = moderation_token {
            self.accept(build_sha, token, obs)?;
            accepted = true;
        }
        Ok(SubmitOutcome { uploaded, unavailable, bytes, accepted })
    }

    /// Ask the server which of the submitted build's asset blobs it lacks,
    /// then PUT each one we hold locally, a few at once. Errors if any upload
    /// fails — the record submission itself has already succeeded by then.
    /// Returns (uploaded blobs, blobs not held locally, bytes confirmed).
    fn upload_missing_assets(
        &self,
        build_sha: &str,
        local: &HashMap<String, PathBuf>,
        obs: &LoaderObserver,
    ) -> Result<(usize, usize, u64)> {
        if local.is_empty() {
            return Ok((0, 0, 0)); // nothing extracted locally — nothing to offer
        }
        let assets_url = format!("{}/api/submissions/{build_sha}/assets", self.base);
        let (code, body) = self.request("GET", &assets_url, &[], None)?;
        if !(200..300).contains(&code) {
            bail!("asset check failed: server error {code} (submission is queued)");
        }
        let missing: Vec<String> = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("missing").and_then(|m| m.as_array()).map(|arr| {
                    arr.iter().filter_map(|s| s.as_str().map(String::from)).collect()
                })
            })
            .unwrap_or_default();
        if missing.is_empty() {
            obs.on_event(Event::Message("assets already on server".into()));
            return Ok((0, 0, 0));
        }
        let todo: Vec<&String> = missing.iter().filter(|sha| local.contains_key(*sha)).collect();
        let unavailable = missing.len() - todo.len();
        if todo.is_empty() {
            obs.on_event(Event::Message(format!(
                "{unavailable} missing asset blobs are not in the local store"
            )));
            return Ok((0, unavailable, 0));
        }
        // Workers pull the next blob off a shared counter; each blob is its own
        // resumable PUT (chunks of one blob never interleave). One counter
        // spans all blobs, counted per completed blob (the loader shows a
        // non-byte counter as k/n rather than a percentage).
        let total = todo.len();
        obs.on_event(Event::CounterOpen {
            id: UPLOAD_ID,
            label: "Uploading".into(),
            unit: "blobs".into(),
            total: Some(total as f64),
        });
        let bytes_done = AtomicU64::new(0);
        let next = AtomicUsize::new(0);
        let completed = AtomicUsize::new(0);
        let ok_count = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..PARALLEL_UPLOADS.min(total) {
                s.spawn(|| loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(sha) = todo.get(i) else { break };
                    // Each blob gets its own byte counter, so the loader's
                    // second bar row tracks the most recently started blob.
                    let id = UPLOAD_ID - 1 - i as u64;
                    let size = std::fs::metadata(&local[*sha]).map(|m| m.len()).unwrap_or(0);
                    obs.on_event(Event::CounterOpen {
                        id,
                        label: format!("{}…", &sha[..12.min(sha.len())]),
                        unit: "B".into(),
                        total: Some(size as f64),
                    });
                    let sent = std::cell::Cell::new(0u64);
                    let ok = self.upload_asset_chunked(&assets_url, sha, &local[*sha], &|delta| {
                        bytes_done.fetch_add(delta as u64, Ordering::Relaxed);
                        sent.set(sent.get() + delta as u64);
                        obs.on_event(Event::Progress { id, count: sent.get() as f64 });
                    });
                    obs.on_event(Event::CounterClose { id });
                    if ok {
                        ok_count.fetch_add(1, Ordering::Relaxed);
                    }
                    let n = completed.fetch_add(1, Ordering::Relaxed) + 1;
                    obs.on_event(Event::Progress { id: UPLOAD_ID, count: n as f64 });
                    let line = format!(
                        "  [{n}/{total}] {}… {}",
                        &sha[..12.min(sha.len())],
                        if ok { "uploaded" } else { "FAILED" }
                    );
                    // Completions tick by in the counter rows; plain mode logs
                    // each, and failures must survive in the scrollback.
                    if ok {
                        obs.plain(line);
                    } else {
                        obs.on_event(Event::Message(line));
                    }
                });
            }
        });
        obs.on_event(Event::CounterClose { id: UPLOAD_ID });
        let uploaded = ok_count.into_inner();
        let failed = total - uploaded;
        let mut note = format!("uploaded {uploaded} asset blob{}", if uploaded == 1 { "" } else { "s" });
        if unavailable > 0 {
            note.push_str(&format!(", {unavailable} not in local store"));
        }
        obs.on_event(Event::Message(note));
        if failed > 0 {
            bail!("{failed} asset upload{} failed (submission is queued; retry to resume)",
                if failed == 1 { "" } else { "s" });
        }
        Ok((uploaded, unavailable, bytes_done.into_inner()))
    }

    /// PUT one asset blob in resumable chunks: each request appends at
    /// `offset`, a 409 answers with the server's staged offset to resume from,
    /// and the final chunk returns `stored` (or `exists`). `report` receives
    /// newly-confirmed byte counts, monotonic per blob (a 409 resume can move
    /// the offset either way, only fresh high-water marks are reported).
    fn upload_asset_chunked(
        &self,
        assets_url: &str,
        sha: &str,
        path: &Path,
        report: &dyn Fn(usize),
    ) -> bool {
        let Ok(bytes) = std::fs::read(path) else { return false };
        let Ok(upload_token) = prism_core::upload_token::new_upload_token() else { return false };
        let mut offset: usize = 0;
        let mut reported: usize = 0;
        let mut last_staged: Option<usize> = None;
        let mut throttled = 0u32;
        while offset < bytes.len() {
            let end = (offset + UPLOAD_CHUNK).min(bytes.len());
            let url = format!("{assets_url}/{sha}?offset={offset}");
            let chunk = &bytes[offset..end];
            let Ok((code, body)) = self.request(
                "PUT",
                &url,
                &[("Content-Type", "application/octet-stream"), ("X-Upload-Token", &upload_token)],
                Some(chunk),
            ) else {
                return false;
            };
            match code {
                c if (200..300).contains(&c) => {
                    let v = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
                    match v.get("status").and_then(|s| s.as_str()) {
                        Some("stored") | Some("exists") => {
                            if bytes.len() > reported {
                                report(bytes.len() - reported);
                            }
                            return true;
                        }
                        _ => {
                            offset = v
                                .get("offset")
                                .and_then(|o| o.as_u64())
                                .map(|o| o as usize)
                                .unwrap_or(end);
                            if offset > reported {
                                report(offset - reported);
                                reported = offset;
                            }
                            last_staged = None;
                            throttled = 0;
                        }
                    }
                }
                429 => {
                    // Rate limited — wait out the window (the server's
                    // retryAfter when present) and retry the same offset.
                    throttled += 1;
                    if throttled > MAX_THROTTLE_RETRIES {
                        return false;
                    }
                    let secs = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("retryAfter").and_then(|r| r.as_f64()))
                        .unwrap_or(5.0)
                        .clamp(1.0, 120.0);
                    std::thread::sleep(Duration::from_secs_f64(secs));
                }
                409 => {
                    // Resume where the server actually is; the same answer
                    // twice means we're not making progress — give up.
                    let staged = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("offset").and_then(|o| o.as_u64()))
                        .map(|o| o as usize)
                        .unwrap_or(0);
                    if last_staged == Some(staged) {
                        return false;
                    }
                    last_staged = Some(staged);
                    offset = staged;
                    if staged > reported {
                        report(staged - reported);
                        reported = staged;
                    }
                }
                _ => return false,
            }
        }
        false // ran out of local bytes without the server confirming the store
    }

    /// Accept the just-submitted build with the moderation token, so the
    /// record (and its refreshed assets) replaces the live build immediately.
    fn accept(&self, build_sha: &str, token: &str, obs: &LoaderObserver) -> Result<()> {
        let url = format!("{}/api/submissions/{build_sha}", self.base);
        let (code, body) = self.request(
            "POST",
            &url,
            &[("Content-Type", "application/json"), ("x-moderation-token", token)],
            Some(br#"{"action":"accept"}"#),
        )?;
        match code {
            c if (200..300).contains(&c) => {
                obs.on_event(Event::Message("accepted — live build updated".into()));
                Ok(())
            }
            401 => bail!("accept failed: moderation token rejected (submission stays queued)"),
            c => bail!("accept failed: server error {c}: {} (submission stays queued)", body.trim()),
        }
    }
}
