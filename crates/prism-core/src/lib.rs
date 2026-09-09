//! Prism core — the UI-agnostic engine shared by the CLI, the native GUIs (via
//! UniFFI), and the export/ingest tooling.
//!
//! Pipeline: hash the image (Rust) → check the sha256 cache → otherwise run the
//! `ps2exe-adapter` subprocess → normalize into the canonical [`BuildRecord`] →
//! render DAT/JSON → cache + index in SQLite.

pub mod adapter;
pub mod cache;
pub mod db;
pub mod error;
pub mod fingerprint;
pub mod progress;
pub mod render;
pub mod schema;
pub mod summary;
pub mod tga;
pub mod upload_token;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use error::{Error, Result};
pub use progress::{Event, NoopObserver, ProgressObserver};
pub use schema::*;

use adapter::AdapterCommand;
use cache::Cache;
use db::Db;

/// Configuration for an [`Analyzer`].
pub struct Config {
    pub adapter: AdapterCommand,
    /// Override the user data dir (cache + db). `None` ⇒ platform default.
    pub data_dir: Option<PathBuf>,
}

/// The orchestrator. One per process is plenty.
pub struct Analyzer {
    cache: Cache,
    db: Db,
    adapter: AdapterCommand,
    data_dir: PathBuf,
}

/// Result of [`Analyzer::analyze`].
pub struct Analysis {
    pub record: BuildRecord,
    /// True when served from the sha256 cache (adapter not run).
    pub from_cache: bool,
    /// Path to the cached JSON.
    pub json_path: PathBuf,
}

impl Analyzer {
    pub fn new(config: Config) -> Result<Self> {
        let data_dir = match config.data_dir {
            Some(d) => {
                std::fs::create_dir_all(&d)?;
                d
            }
            None => cache::default_data_dir()?,
        };
        let cache = Cache::open(Some(&data_dir))?;
        let db = Db::open(&data_dir)?;
        Ok(Analyzer { cache, db, adapter: config.adapter, data_dir })
    }

    /// Open a lock-free read side of the library (a second DB connection + the record
    /// cache) — for a GUI's browser, so queries *and* opening a build run concurrently
    /// with an in-progress import (which holds the writer). See WAL in [`Db::open`].
    pub fn open_reader(&self) -> Result<Reader> {
        Ok(Reader {
            db: Db::open(&self.data_dir)?,
            cache: Cache::open(Some(&self.data_dir))?,
            data_dir: self.data_dir.clone(),
        })
    }

    /// Analyze one image/container, or a folder holding one build split across
    /// files (a multi-track dump — identity comes from the track set, see
    /// [`fingerprint::hash_image`]). Idempotent: a known sha256 is served from
    /// cache.
    pub fn analyze(
        &self,
        path: &str,
        observer: Arc<dyn ProgressObserver>,
    ) -> Result<Analysis> {
        self.analyze_impl(path, observer, false)
    }

    /// Analyze ignoring any cached record: full re-parse and re-hash, replacing
    /// the stored record and library row. For builds whose earlier parse is
    /// known bad (e.g. a since-fixed reader bug) — a plain re-analyze is a
    /// cache hit that only tops up assets and never re-hashes files.
    pub fn reanalyze(
        &self,
        path: &str,
        observer: Arc<dyn ProgressObserver>,
    ) -> Result<Analysis> {
        self.analyze_impl(path, observer, true)
    }

    fn analyze_impl(
        &self,
        path: &str,
        observer: Arc<dyn ProgressObserver>,
        force: bool,
    ) -> Result<Analysis> {
        // 1. Image identity (single streaming read in Rust).
        let image = fingerprint::hash_image(path, &observer)?;

        // 2. Cache short-circuit. Records whose assets predate the current
        // ASSET_PROFILE (or never ran, assets == None) get topped up here —
        // extraction alone, no re-hash — so re-running analyze over an existing
        // collection backfills its asset store.
        if !force {
            if let Some(mut record) = self.cache.load(&image.sha256)? {
                observer.on_event(Event::Message(format!("cache hit {}", image.sha256)));
                let mut dirty = false;
                // Same bytes under a new source name (naming rules improved, or
                // the dump was renamed): refresh the display name, so a plain
                // re-import fixes stale names. Last import wins.
                if record.image.name != image.name {
                    record.image.name = image.name.clone();
                    dirty = true;
                }
                if record.assets.is_none() || record.asset_profile < schema::ASSET_PROFILE {
                    if let Some(assets) = self.extract_assets(path, &observer)? {
                        record.assets = Some(assets);
                        record.asset_profile = schema::ASSET_PROFILE;
                        dirty = true;
                    }
                }
                if dirty {
                    let xml = render::to_dat_xml(&record);
                    let jp = self.cache.store(&record, &xml)?;
                    self.db.upsert_build(&record, &jp.to_string_lossy())?;
                }
                let json_path = self.cache.json_path(&image.sha256);
                return Ok(Analysis { record, from_cache: true, json_path });
            }
        }

        // 3. Parse + extract via the adapter (Python/ps2exe).
        let raw = adapter::run(&self.adapter, path, observer.clone())?;
        if raw.files.is_empty() {
            return Err(Error::Unsupported(path.to_string()));
        }

        // 4. Normalize into the canonical record.
        let info = schema::DiscInfo {
            system: raw.info.system.clone(),
            system_identifier: raw.info.system_identifier.clone(),
            header: schema::Header {
                title: raw.info.header.title.clone(),
                product_number: raw.info.header.product_number.clone(),
                product_version: raw.info.header.product_version.clone(),
                release_date: raw.info.header.release_date.clone(),
                maker_id: raw.info.header.maker_id.clone(),
                device_info: raw.info.header.device_info.clone(),
                regions: raw.info.header.regions.clone(),
            },
            volume: schema::Volume {
                identifier: raw.info.volume.identifier.clone(),
                set_identifier: raw.info.volume.set_identifier.clone(),
                creation_date: raw.info.volume.creation_date.clone(),
                modification_date: raw.info.volume.modification_date.clone(),
                expiration_date: raw.info.volume.expiration_date.clone(),
                effective_date: raw.info.volume.effective_date.clone(),
            },
            exe: raw.info.exe.as_ref().map(|e| schema::Exe {
                filename: e.filename.clone(),
                date: e.date.clone(),
                signing_type: e.signing_type.clone(),
                num_symbols: e.num_symbols,
            }),
            alt_exe: raw.info.alt_exe.as_ref().map(|e| schema::AltExe {
                filename: e.filename.clone(),
                date: e.date.clone(),
                md5: e.md5.clone(),
            }),
            sfo: raw.info.sfo.as_ref().map(|s| schema::Sfo {
                title: s.title.clone(),
                disc_id: s.disc_id.clone(),
                disc_version: s.disc_version.clone(),
                category: s.category.clone(),
                parental_level: s.parental_level.clone(),
                system_version: s.system_version.clone(),
            }),
            disc_type: raw.info.disc_type.clone(),
        };

        let composites = fingerprint::composites(&raw.files);
        let structural = fingerprint::structural(&info.system, &raw.files);
        let text_doc = fingerprint::text_doc(&info, &raw.files);
        let chunk_signature = fingerprint::chunk_signature(&raw.files);
        let resemblance = fingerprint::resemblance_signature(&raw.files);
        let sidecar = fingerprint::chunk_sidecar(&raw.files);
        let contents = fingerprint::build_tree(&raw.files);

        // Asset pass: pull browser-viewable files (images/audio/text ≤ 20MB) whole
        // and every other file's head snippet into the content-addressed store.
        // Enrichment only — a failure is reported and leaves `assets` unset
        // (None), so the next analyze retries it.
        let assets = self.extract_assets(path, &observer)?;
        let asset_profile = if assets.is_some() { schema::ASSET_PROFILE } else { 0 };

        let record = BuildRecord {
            record_schema_version: schema::RECORD_SCHEMA_VERSION,
            fingerprint_profile: schema::FINGERPRINT_PROFILE.to_string(),
            image,
            info,
            composites,
            structural,
            text_doc,
            contents,
            media: raw
                .media
                .iter()
                .map(|m| schema::MediaFp {
                    path: m.path.clone(),
                    kind: m.kind.clone(),
                    phash: None,
                    chromaprint: None,
                    audio_fp: m.audio_fp.clone(),
                })
                .collect(),
            exe_fp: raw.exe_fp.as_ref().and_then(|e| {
                if e.tlsh.is_none() && e.imphash.is_none() {
                    None
                } else {
                    Some(schema::ExeFp {
                        tlsh: e.tlsh.clone(),
                        imphash: e.imphash.clone(),
                        func_hashes: Vec::new(),
                    })
                }
            }),
            chunk_signature,
            resemblance,
            assets,
            asset_profile,
        };

        // 5. Render, cache, index.
        let xml = render::to_dat_xml(&record);
        let json_path = self.cache.store(&record, &xml)?;
        self.cache.store_chunks(&record.image.sha256, &sidecar)?;
        self.db
            .upsert_build(&record, &json_path.to_string_lossy())?;

        Ok(Analysis { record, from_cache: false, json_path })
    }

    /// The content-addressed asset store (blobs at `<dir>/<sha256[:2]>/<sha256>`).
    pub fn assets_dir(&self) -> PathBuf {
        self.data_dir.join("assets")
    }

    /// Absolute path of one asset blob, or `None` when the sha is malformed or
    /// the blob isn't in the local store.
    pub fn asset_blob_path(&self, sha256: &str) -> Option<PathBuf> {
        asset_blob_in(&self.assets_dir(), sha256)
    }

    /// Run the adapter's asset extraction into the store. Failures degrade to a
    /// progress message and `None` (retried on the next analyze) — except
    /// cancellation, which propagates like everywhere else.
    fn extract_assets(
        &self,
        path: &str,
        observer: &Arc<dyn ProgressObserver>,
    ) -> Result<Option<Vec<schema::AssetRef>>> {
        let dir = self.assets_dir();
        std::fs::create_dir_all(&dir)?;
        match adapter::run_extract(&self.adapter, path, &dir.to_string_lossy(), observer.clone()) {
            Ok(raw) => Ok(Some(
                raw.into_iter()
                    .filter(|a| is_sha256_hex(&a.sha256))
                    .map(|a| schema::AssetRef {
                        path: a.path,
                        sha256: a.sha256,
                        size: a.size,
                        mime: a.mime,
                        kind: a.kind,
                    })
                    .collect(),
            )),
            Err(Error::Cancelled) => Err(Error::Cancelled),
            Err(e) => {
                observer.on_event(Event::Message(format!("asset extraction failed: {e}")));
                Ok(None)
            }
        }
    }

    /// Number of builds in the local library.
    pub fn library_size(&self) -> Result<u64> {
        self.db.count_builds()
    }

    /// The most recently analyzed builds, newest first.
    pub fn recent_builds(&self, limit: u32) -> Result<Vec<db::LibraryRow>> {
        self.db.list_recent(limit)
    }

    /// Search/browse the library (name+system substring, optional system filter,
    /// sortable, paged). Backs the library browser in the GUIs.
    pub fn search_library(
        &self,
        search: Option<&str>,
        system: Option<&str>,
        sort: db::LibrarySort,
        desc: bool,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<db::LibraryRow>> {
        self.db.search_builds(search, system, sort, desc, limit, offset)
    }

    /// Distinct systems in the library (for the browser's filter control).
    pub fn library_systems(&self) -> Result<Vec<String>> {
        self.db.list_systems()
    }

    /// Reload a previously analyzed build from the sha256 cache (no adapter run).
    pub fn load_cached(&self, sha256: &str) -> Result<Option<Analysis>> {
        match self.cache.load(sha256)? {
            Some(record) => Ok(Some(Analysis {
                record,
                from_cache: true,
                json_path: self.cache.json_path(sha256),
            })),
            None => Ok(None),
        }
    }

    /// Every library record from the on-disk cache, applied to `f` in turn.
    /// Pruned/unparseable cache entries are skipped. Returns the count.
    fn for_each_record<F: FnMut(BuildRecord) -> Result<()>>(&self, mut f: F) -> Result<u64> {
        let mut n = 0;
        for path in self.db.list_json_paths()? {
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue, // cache entry pruned; skip
            };
            let record: BuildRecord = match serde_json::from_slice(&bytes) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("skipping unparseable cache entry {path}: {e}");
                    continue;
                }
            };
            f(record)?;
            n += 1;
        }
        Ok(n)
    }

    /// Export the library as JSON Lines (one canonical build record per line) — the
    /// bulk desktop→web contribute feed. Returns the number of records written.
    /// Asset *blobs* don't ride along here — use a `.zip` bundle for those.
    pub fn export_jsonl<W: std::io::Write>(&self, mut out: W) -> Result<u64> {
        self.for_each_record(|record| {
            // Re-emit compactly, one record per line.
            serde_json::to_writer(&mut out, &record)?;
            out.write_all(b"\n")?;
            Ok(())
        })
    }

    /// Export the library as a portable bundle: a ZIP holding `builds.jsonl` (the
    /// JSON-Lines feed) plus a self-describing `manifest.json`. This is the format
    /// to copy between machines and ingest into the web service; it's
    /// double-clickable on macOS/Windows. Returns the number of records written.
    pub fn export_bundle(&self, path: &Path) -> Result<u64> {
        use sha2::{Digest, Sha256};
        use zip::write::SimpleFileOptions;

        let zip_err = |e: zip::result::ZipError| Error::Other(format!("zip: {e}"));
        let file = std::fs::File::create(path)?;
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default();

        // Records first, hashing the exact bytes we store so the manifest can carry
        // an integrity digest the importer can verify. Collect the records' asset
        // hashes on the way — their blobs join the bundle below.
        let n;
        let mut asset_shas = std::collections::BTreeSet::new();
        let body_sha256 = {
            zip.start_file("builds.jsonl", opts).map_err(zip_err)?;
            let mut hasher = Sha256::new();
            {
                let mut hw = HashingWriter { inner: &mut zip, hasher: &mut hasher };
                n = self.for_each_record(|record| {
                    for a in record.assets.as_deref().unwrap_or_default() {
                        if is_sha256_hex(&a.sha256) {
                            asset_shas.insert(a.sha256.clone());
                        }
                    }
                    serde_json::to_writer(&mut hw, &record)?;
                    hw.write_all(b"\n")?;
                    Ok(())
                })?;
            }
            hex::encode(hasher.finalize())
        };

        // Asset blobs, deduplicated across builds by content hash. A blob missing
        // from the local store is skipped with a warning — the record's metadata
        // still ships, and a later bundle can supply the bytes.
        let store = self.assets_dir();
        let mut shipped = 0u64;
        let mut missing = 0u64;
        for sha in &asset_shas {
            let blob = store.join(&sha[..2]).join(sha);
            let bytes = match std::fs::read(&blob) {
                Ok(b) => b,
                Err(_) => {
                    missing += 1;
                    continue;
                }
            };
            zip.start_file(format!("assets/{sha}"), opts).map_err(zip_err)?;
            zip.write_all(&bytes)?;
            shipped += 1;
        }
        if missing > 0 {
            eprintln!("warning: {missing} asset blob(s) not in the local store; bundle ships without them");
        }

        zip.start_file("manifest.json", opts).map_err(zip_err)?;
        let manifest = serde_json::json!({
            "prism_bundle": 1,
            "record_schema_version": schema::RECORD_SCHEMA_VERSION,
            "fingerprint_profile": schema::FINGERPRINT_PROFILE,
            "count": n,
            "assets_count": shipped,
            "tool_version": env!("CARGO_PKG_VERSION"),
            "created_at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            "body_sha256": body_sha256,
        });
        serde_json::to_writer_pretty(&mut zip, &manifest)?;
        zip.finish().map_err(zip_err)?;
        Ok(n)
    }
}

/// Bare 64-char lowercase-hex sha256 — safe to interpolate into a store path.
fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Extensions ps2exe skips when walking a tree — mirrors `is_path_allowed` in
/// `lib/ps2exe/utils/common.py` (the source of truth; keep in sync). Folder import
/// uses this so it doesn't waste time hashing obvious non-discs, and so descriptor /
/// sidecar files (`.cue`/`.ccd`/`.sub`/…) don't import as duplicates of the disc
/// they belong to.
const NON_DISC_EXTENSIONS: &[&str] = &[
    "html", "htm", "jpeg", "jpg", "png", "bmp", "gif", "tif", "txt", "pdf", "dat", "json", "sfv",
    "sha1", "md5", "par2", "cue", "ccd", "sub", "gdi", "cdi", "raw", "c2", "subcode", "fulltoc",
    "wav", "mp3", "avi", "exe", "nfo", "part", "dctmp", "state",
];

/// Console-specific metadata blobs ps2exe always ignores (also from `is_path_allowed`).
const IGNORED_FILENAMES: &[&str] = &["ip.bin", "ss.bin", "pfi.bin", "dmi.bin"];

/// Whether `path`'s name looks like a disc image/container worth handing to the
/// adapter (vs. an obvious non-disc the adapter would reject anyway).
fn looks_importable(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    let lower = name.to_ascii_lowercase();
    if IGNORED_FILENAMES.contains(&lower.as_str()) {
        return false;
    }
    // `Data####` split-dump metadata (e.g. Data0001), matched at the end of the name.
    if lower.len() >= 8 {
        let (head, tail) = lower.split_at(lower.len() - 4);
        if tail.bytes().all(|b| b.is_ascii_digit()) && head.ends_with("data") {
            return false;
        }
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => !NON_DISC_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()),
        None => true, // extensionless files (e.g. a bare track) are worth a try
    }
}

/// Lock-free read side of the library: a second DB connection plus the on-disk record
/// cache. A GUI holds one so browsing and opening builds keep working while an import
/// holds the writer. Built by [`Analyzer::open_reader`].
pub struct Reader {
    db: Db,
    cache: Cache,
    data_dir: PathBuf,
}

impl Reader {
    /// Search/browse the library — see [`Analyzer::search_library`].
    pub fn search_builds(
        &self,
        search: Option<&str>,
        system: Option<&str>,
        sort: db::LibrarySort,
        desc: bool,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<db::LibraryRow>> {
        self.db.search_builds(search, system, sort, desc, limit, offset)
    }

    /// Distinct systems present in the library.
    pub fn list_systems(&self) -> Result<Vec<String>> {
        self.db.list_systems()
    }

    /// Most recently analyzed builds, newest first.
    pub fn list_recent(&self, limit: u32) -> Result<Vec<db::LibraryRow>> {
        self.db.list_recent(limit)
    }

    /// Load a build from the record cache by sha256 (no writer lock, no adapter run).
    pub fn load_cached(&self, sha256: &str) -> Result<Option<Analysis>> {
        match self.cache.load(sha256)? {
            Some(record) => Ok(Some(Analysis {
                record,
                from_cache: true,
                json_path: self.cache.json_path(sha256),
            })),
            None => Ok(None),
        }
    }

    /// The content-addressed asset store — see [`Analyzer::assets_dir`].
    pub fn assets_dir(&self) -> PathBuf {
        self.data_dir.join("assets")
    }

    /// Absolute path of one asset blob — see [`Analyzer::asset_blob_path`].
    pub fn asset_blob_path(&self, sha256: &str) -> Option<PathBuf> {
        asset_blob_in(&self.assets_dir(), sha256)
    }
}

/// `<store>/<sha256[:2]>/<sha256>` when the sha is well-formed and the blob
/// exists locally. Hex validation makes the interpolation path-safe.
fn asset_blob_in(store: &Path, sha256: &str) -> Option<PathBuf> {
    if !is_sha256_hex(sha256) {
        return None;
    }
    let path = store.join(&sha256[..2]).join(sha256);
    path.is_file().then_some(path)
}

/// Descriptor files that lay out one disc's tracks. Exactly one at a folder's top
/// level marks the folder as a single multi-track build (see
/// [`folder_is_single_build`]).
const DISC_DESCRIPTOR_EXTENSIONS: &[&str] = &["cue", "gdi", "ccd"];

/// Whether `root` holds ONE dump split across files (a multi-track disc) rather
/// than a collection of separate images. True when the folder's top level has
/// exactly one `.cue`/`.gdi`/`.ccd` descriptor and at least one importable file,
/// or no descriptor but two or more importable files all named like tracks of one
/// set ("Track 1.bin", "Game (Track 02).bin", …) with a matching prefix. A folder
/// whose subdirectories hold importable files is a collection, never a single
/// build. `Open Folder as Build` bypasses this check — it's for routing drops and
/// batch imports.
pub fn folder_is_single_build(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else { return false };
    let mut descriptors = 0usize;
    let mut stems: Vec<String> = Vec::new(); // lowercased stems of importable files
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => {
                if !list_importable_files(&path).is_empty() {
                    return false;
                }
            }
            Ok(ft) if ft.is_file() => {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_ascii_lowercase());
                if ext.as_deref().is_some_and(|e| DISC_DESCRIPTOR_EXTENSIONS.contains(&e)) {
                    descriptors += 1;
                } else if looks_importable(&path) {
                    stems.push(
                        path.file_stem()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_ascii_lowercase(),
                    );
                }
            }
            _ => {}
        }
    }
    if stems.is_empty() {
        return false;
    }
    match descriptors {
        1 => true,
        0 => stems.len() >= 2 && is_track_set(&stems),
        _ => false, // several descriptors ⇒ several discs
    }
}

/// True when every stem ends in a track-number suffix and the prefixes before it
/// all match — the naming of one split dump.
fn is_track_set(stems: &[String]) -> bool {
    let mut prefix: Option<&str> = None;
    for stem in stems {
        let Some(p) = strip_track_suffix(stem) else { return false };
        if *prefix.get_or_insert(p) != p {
            return false;
        }
    }
    true
}

/// For a (lowercased) stem like "game (track 12)", the prefix before the track
/// suffix ("game"), or `None` when the stem doesn't end in one. "track" must sit
/// at the stem's start or after a separator, so "backtrack 2" doesn't count.
fn strip_track_suffix(stem: &str) -> Option<&str> {
    let base = stem.trim_end().trim_end_matches(')');
    let no_digits = base.trim_end_matches(|c: char| c.is_ascii_digit());
    if no_digits.len() == base.len() {
        return None; // no trailing digits
    }
    let s = no_digits.trim_end_matches([' ', '_', '-', '#', '.']).strip_suffix("track")?;
    if !s.is_empty() && !s.ends_with([' ', '-', '_', '(', '.']) {
        return None;
    }
    Some(s.trim_end_matches(['(', ' ', '-', '_', '.']))
}

/// Display name for a folder opened as one build. Prefers the dump's own naming
/// over the folder's: the descriptor stem when every track file corroborates it
/// (`Build Name.cue` + `Build Name (Track 1).bin` → "Build Name"), else the
/// tracks' shared prefix (`Game (Track 1).bin` + `Game (Track 2).bin` →
/// "Game"), else the one stem all importable files share (`Dump 1/asdf.iso` →
/// "asdf", and likewise a raw dump's same-named sidecar family `x.scram` +
/// `x.toc` + `x.atip` → "x"), else the folder name. Corroboration keeps
/// generic descriptors out:
/// a GDI dump's `disc.gdi` + `track01.bin` would otherwise name the build
/// "disc". Display only: identity never depends on names (see
/// [`fingerprint::hash_image`]).
pub fn folder_build_name(root: &Path) -> String {
    let fallback = || {
        root.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| root.to_string_lossy().into_owned())
    };

    // Top-level descriptors, original case.
    let mut descriptor_stems: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_descriptor = entry.file_type().is_ok_and(|ft| ft.is_file())
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| {
                        DISC_DESCRIPTOR_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str())
                    });
            if is_descriptor {
                descriptor_stems
                    .push(path.file_stem().unwrap_or_default().to_string_lossy().into_owned());
            }
        }
    }

    // Stems of the files that make up the image (same set identity hashes),
    // original case.
    let stems: Vec<String> = list_importable_files(root)
        .iter()
        .map(|p| p.file_stem().unwrap_or_default().to_string_lossy().into_owned())
        .collect();
    if stems.is_empty() {
        return fallback();
    }

    // Exactly one descriptor whose stem every track name starts with.
    if let [stem] = descriptor_stems.as_slice() {
        let lower = stem.to_ascii_lowercase();
        if !lower.is_empty() && stems.iter().all(|s| s.to_ascii_lowercase().starts_with(&lower)) {
            return stem.clone();
        }
    }

    // A track set with a shared non-empty prefix names itself. ASCII lowercasing
    // is byte-for-byte, so the prefix length maps straight back onto the
    // original-case stem.
    let lower_stems: Vec<String> = stems.iter().map(|s| s.to_ascii_lowercase()).collect();
    if is_track_set(&lower_stems) {
        if let Some(prefix) = strip_track_suffix(&lower_stems[0]) {
            if !prefix.is_empty() {
                return stems[0][..prefix.len()].to_string();
            }
        }
    }

    // All importable files sharing one stem — a lone image, or an image with
    // same-named sidecars (raw dumps: x.scram + x.toc + x.atip) — name the
    // build after that stem. Bare track labels ("track01") are excluded — such
    // files only mean something inside their folder, which then does the naming.
    if let Some((first, rest)) = lower_stems.split_first() {
        if !first.is_empty()
            && rest.iter().all(|s| s == first)
            && strip_track_suffix(first).is_none()
        {
            return stems[0].clone();
        }
    }

    fallback()
}

/// The files that constitute a folder-as-one-build's disc image: its importable
/// files in natural name order ("Track 2" before "Track 10"), so identity hashing
/// concatenates the tracks in disc order.
pub fn dir_image_files(root: &Path) -> Vec<PathBuf> {
    let mut files = list_importable_files(root);
    files.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));
    files
}

/// Case-insensitive ordering that compares embedded digit runs by numeric value,
/// with a raw tiebreak so the order is total and deterministic.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0usize, 0usize);
    while i < ab.len() && j < bb.len() {
        if ab[i].is_ascii_digit() && bb[j].is_ascii_digit() {
            let (si, sj) = (i, j);
            while i < ab.len() && ab[i].is_ascii_digit() {
                i += 1;
            }
            while j < bb.len() && bb[j].is_ascii_digit() {
                j += 1;
            }
            let da = trim_leading_zeros(&ab[si..i]);
            let db = trim_leading_zeros(&bb[sj..j]);
            match da.len().cmp(&db.len()).then_with(|| da.cmp(db)) {
                Ordering::Equal => {}
                other => return other,
            }
        } else {
            match ab[i].to_ascii_lowercase().cmp(&bb[j].to_ascii_lowercase()) {
                Ordering::Equal => {
                    i += 1;
                    j += 1;
                }
                other => return other,
            }
        }
    }
    (ab.len() - i).cmp(&(bb.len() - j)).then_with(|| a.cmp(b))
}

fn trim_leading_zeros(digits: &[u8]) -> &[u8] {
    let start = digits.iter().position(|&b| b != b'0').unwrap_or(digits.len() - 1);
    &digits[start..]
}

/// Import units under `root`: like [`list_importable_files`], but a directory
/// holding one build split across files (see [`folder_is_single_build`]) comes
/// back as a single unit instead of its member files, so batch import analyzes
/// it as one build. When `root` itself is such a folder, it is the sole unit.
pub fn list_import_units(root: &Path) -> Vec<PathBuf> {
    if folder_is_single_build(root) {
        return vec![root.to_path_buf()];
    }
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => {
                    let path = entry.path();
                    if folder_is_single_build(&path) {
                        out.push(path);
                    } else {
                        stack.push(path);
                    }
                }
                Ok(ft) if ft.is_file() && looks_importable(&entry.path()) => out.push(entry.path()),
                _ => {}
            }
        }
    }
    out.sort();
    out
}

/// Recursively collect importable files under `root`, depth-first, sorted for a
/// deterministic order. Non-disc files (per ps2exe's blocklist) and symlinks are
/// skipped; unreadable directories are silently skipped. Backs the GUIs' folder
/// import, which then tries to analyze each returned file and skips any that don't
/// parse. (Single-file "Open" bypasses this filter — it tries whatever you pick.)
pub fn list_importable_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(ft) if ft.is_dir() => stack.push(entry.path()),
                Ok(ft) if ft.is_file() && looks_importable(&entry.path()) => out.push(entry.path()),
                _ => {} // dirs handled above; symlinks / specials / non-disc files: skip
            }
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod walk_tests {
    use super::list_importable_files;

    #[test]
    fn recurses_disc_files_skips_non_discs_and_is_sorted() {
        let root = std::env::temp_dir().join(format!("prism-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub/deep")).unwrap();
        // disc-like — kept
        std::fs::write(root.join("b.iso"), b"x").unwrap();
        std::fs::write(root.join("a.zip"), b"x").unwrap();
        std::fs::write(root.join("sub/c.bin"), b"x").unwrap();
        std::fs::write(root.join("sub/deep/game.chd"), b"x").unwrap();
        // non-disc / sidecar / metadata — skipped per ps2exe's blocklist
        std::fs::write(root.join("disc.cue"), b"x").unwrap();
        std::fs::write(root.join("readme.txt"), b"x").unwrap();
        std::fs::write(root.join("scan.jpg"), b"x").unwrap();
        std::fs::write(root.join("IP.BIN"), b"x").unwrap(); // case-insensitive
        std::fs::write(root.join("Data0001"), b"x").unwrap();

        let rel: Vec<String> = list_importable_files(&root)
            .iter()
            .map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(rel, ["a.zip", "b.iso", "sub/c.bin", "sub/deep/game.chd"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_root_yields_empty() {
        let root = std::env::temp_dir().join("prism-walk-nope-zzz");
        let _ = std::fs::remove_dir_all(&root);
        assert!(list_importable_files(&root).is_empty());
    }
}

#[cfg(test)]
mod folder_build_tests {
    use super::{
        dir_image_files, folder_build_name, folder_is_single_build, list_import_units, natural_cmp,
    };
    use std::path::{Path, PathBuf};

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("prism-fb-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    #[test]
    fn cue_plus_tracks_is_single_build() {
        let root = scratch("cue");
        touch(&root, "Track 1.bin");
        touch(&root, "Track 2.bin");
        touch(&root, "disc.cue");
        assert!(folder_is_single_build(&root));
        assert_eq!(list_import_units(&root), vec![root.clone()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn track_named_bins_without_cue_are_single_build() {
        let root = scratch("nocue");
        touch(&root, "Track 1.bin");
        touch(&root, "Track 2.bin");
        assert!(folder_is_single_build(&root));

        // Redump-style naming with a shared prefix counts too.
        let root2 = scratch("redump");
        touch(&root2, "Game (USA) (Track 1).bin");
        touch(&root2, "Game (USA) (Track 02).bin");
        assert!(folder_is_single_build(&root2));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&root2);
    }

    #[test]
    fn collections_are_not_single_builds() {
        // Two descriptors ⇒ two discs.
        let root = scratch("twodiscs");
        touch(&root, "disc1.cue");
        touch(&root, "disc1.bin");
        touch(&root, "disc2.cue");
        touch(&root, "disc2.bin");
        assert!(!folder_is_single_build(&root));

        // Unrelated loose images, no descriptor.
        let root2 = scratch("loose");
        touch(&root2, "game-a.iso");
        touch(&root2, "game-b.iso");
        assert!(!folder_is_single_build(&root2));

        // A single lone image isn't a *split* build; "backtrack" isn't "track".
        let root3 = scratch("lone");
        touch(&root3, "backtrack 1.bin");
        touch(&root3, "backtrack 2.bin");
        assert!(!folder_is_single_build(&root3));

        // A subdirectory with importable content ⇒ collection.
        let root4 = scratch("nested");
        touch(&root4, "disc.cue");
        touch(&root4, "Track 1.bin");
        touch(&root4, "extras/bonus.iso");
        assert!(!folder_is_single_build(&root4));

        for r in [root, root2, root3, root4] {
            let _ = std::fs::remove_dir_all(&r);
        }
    }

    #[test]
    fn import_units_group_single_build_dirs() {
        let root = scratch("units");
        touch(&root, "loose.iso");
        touch(&root, "dump/Track 1.bin");
        touch(&root, "dump/Track 2.bin");
        touch(&root, "dump/disc.cue");
        touch(&root, "other/a.chd");
        touch(&root, "other/b.chd");
        let rel: Vec<String> = list_import_units(&root)
            .iter()
            .map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"))
            .collect();
        assert_eq!(rel, ["dump", "loose.iso", "other/a.chd", "other/b.chd"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dir_image_files_use_natural_track_order() {
        let root = scratch("order");
        for name in ["Track 1.bin", "Track 2.bin", "Track 10.bin", "disc.cue"] {
            touch(&root, name);
        }
        let names: Vec<String> = dir_image_files(&root)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["Track 1.bin", "Track 2.bin", "Track 10.bin"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_build_name_prefers_corroborated_descriptor_stem() {
        let root = scratch("name-cue");
        touch(&root, "Build Name.cue");
        touch(&root, "Build Name (Track 1).bin");
        touch(&root, "Build Name (Track 2).bin");
        assert_eq!(folder_build_name(&root), "Build Name");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_build_name_rejects_uncorroborated_descriptor() {
        // GDI convention: generic disc.gdi + track01.bin, where the tracks don't
        // start with "disc" and their shared prefix is empty, so the folder names it.
        let root = scratch("name-gdi");
        touch(&root, "disc.gdi");
        touch(&root, "track01.bin");
        touch(&root, "track02.bin");
        assert_eq!(folder_build_name(&root), root.file_name().unwrap().to_string_lossy());

        // Cue stem the files don't share, and no track naming: folder again.
        let root2 = scratch("name-mismatch");
        touch(&root2, "game_final.cue");
        touch(&root2, "data.bin");
        touch(&root2, "audio.bin");
        assert_eq!(folder_build_name(&root2), root2.file_name().unwrap().to_string_lossy());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&root2);
    }

    #[test]
    fn folder_build_name_uses_shared_track_prefix() {
        // No descriptor, and the prefix keeps the files' original case.
        let root = scratch("name-prefix");
        touch(&root, "Jet Set Radio (Track 1).bin");
        touch(&root, "Jet Set Radio (Track 2).bin");
        assert_eq!(folder_build_name(&root), "Jet Set Radio");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_build_name_uses_lone_image_stem() {
        // One image, no descriptor: the file names the build, not the folder.
        let root = scratch("name-lone");
        touch(&root, "asdf.iso");
        assert_eq!(folder_build_name(&root), "asdf");

        // A bare track label doesn't count as the dump's own name.
        let root2 = scratch("name-lone-track");
        touch(&root2, "disc.gdi");
        touch(&root2, "track01.bin");
        assert_eq!(folder_build_name(&root2), root2.file_name().unwrap().to_string_lossy());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&root2);
    }

    #[test]
    fn folder_build_name_uses_shared_sidecar_stem() {
        // Raw-dump family: several importable files, one stem between them.
        let root = scratch("name-raw");
        touch(&root, "Icewind Dale Ads 12-11-99 1280.scram");
        touch(&root, "Icewind Dale Ads 12-11-99 1280.toc");
        touch(&root, "Icewind Dale Ads 12-11-99 1280.atip");
        touch(&root, "Icewind Dale Ads 12-11-99 1280.log");
        touch(&root, "Icewind Dale Ads 12-11-99 1280.subcode"); // blocklisted sidecar
        assert_eq!(folder_build_name(&root), "Icewind Dale Ads 12-11-99 1280");

        // Two stems: no self-naming, the folder names it.
        let root2 = scratch("name-two-stems");
        touch(&root2, "game-a.iso");
        touch(&root2, "game-b.iso");
        assert_eq!(folder_build_name(&root2), root2.file_name().unwrap().to_string_lossy());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&root2);
    }

    #[test]
    fn folder_build_name_falls_back_to_folder() {
        // Bare numbered tracks: descriptor uncorroborated, prefix empty.
        let root = scratch("name-bare");
        touch(&root, "disc.cue");
        touch(&root, "Track 1.bin");
        touch(&root, "Track 2.bin");
        assert_eq!(folder_build_name(&root), root.file_name().unwrap().to_string_lossy());

        // No importable files at all.
        let root2 = scratch("name-empty");
        touch(&root2, "readme.txt");
        assert_eq!(folder_build_name(&root2), root2.file_name().unwrap().to_string_lossy());

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&root2);
    }

    #[test]
    fn natural_cmp_orders_numbers_by_value() {
        use std::cmp::Ordering;
        assert_eq!(natural_cmp("track 2", "track 10"), Ordering::Less);
        assert_eq!(natural_cmp("Track 02", "track 2"), Ordering::Less); // total order tiebreak
        assert_eq!(natural_cmp("a", "ab"), Ordering::Less);
        assert_eq!(natural_cmp("b1", "a2"), Ordering::Greater);
    }
}

#[cfg(test)]
mod cache_hit_tests {
    use super::*;

    #[test]
    fn cache_hit_refreshes_stale_display_name() {
        let base = std::env::temp_dir().join(format!("prism-rename-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let data_dir = base.join("data");
        let folder = base.join("Dump 1");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("Build Name.cue"), b"cue").unwrap();
        std::fs::write(folder.join("Build Name (Track 1).bin"), b"aaa").unwrap();
        std::fs::write(folder.join("Build Name (Track 2).bin"), b"bbb").unwrap();

        let observer: Arc<dyn ProgressObserver> = Arc::new(NoopObserver);
        let image = fingerprint::hash_image(folder.to_str().unwrap(), &observer).unwrap();
        assert_eq!(image.name, "Build Name");

        // Seed the cache with the same identity under a stale name, with assets
        // current so the cache-hit path never spawns the adapter.
        let analyzer = Analyzer::new(Config {
            adapter: AdapterCommand {
                program: "false".into(),
                args: vec![],
                debug_log: None,
            },
            data_dir: Some(data_dir),
        })
        .unwrap();
        let stale = BuildRecord {
            record_schema_version: schema::RECORD_SCHEMA_VERSION,
            fingerprint_profile: schema::FINGERPRINT_PROFILE.into(),
            image: ImageInfo { name: "Dump 1".into(), ..image.clone() },
            info: DiscInfo::default(),
            composites: Composites::default(),
            structural: Structural {
                system: "PSX".into(),
                file_count: 2,
                total_size: 6,
                max_depth: 1,
                ext_histogram: Default::default(),
            },
            text_doc: String::new(),
            contents: vec![],
            media: vec![],
            exe_fp: None,
            chunk_signature: None,
            resemblance: None,
            assets: Some(vec![]),
            asset_profile: schema::ASSET_PROFILE,
        };
        let xml = render::to_dat_xml(&stale);
        let jp = analyzer.cache.store(&stale, &xml).unwrap();
        analyzer.db.upsert_build(&stale, &jp.to_string_lossy()).unwrap();

        let analysis = analyzer.analyze(folder.to_str().unwrap(), observer).unwrap();
        assert!(analysis.from_cache);
        assert_eq!(analysis.record.image.name, "Build Name");

        // The refresh is persisted, not just returned.
        let reloaded = analyzer.cache.load(&image.sha256).unwrap().unwrap();
        assert_eq!(reloaded.image.name, "Build Name");

        let _ = std::fs::remove_dir_all(&base);
    }
}

/// A `Write` that tees everything into a SHA-256 hasher on its way to `inner`.
struct HashingWriter<'a, W: Write> {
    inner: &'a mut W,
    hasher: &'a mut sha2::Sha256,
}

impl<W: Write> Write for HashingWriter<'_, W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        use sha2::Digest;
        let written = self.inner.write(buf)?;
        self.hasher.update(&buf[..written]);
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}
