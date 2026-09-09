//! Image hashing, content composites, structural features, and tree building.
//!
//! Per-file content access (for chunking, media, and exe fingerprints) lives
//! in the adapter, where file bytes are extractable. This module covers everything
//! derivable in Rust from the image bytes and the adapter's per-file hashes.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::sync::Arc;

use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256};

use crate::adapter::RawFile;
use crate::error::Result;
use crate::progress::{Event, ProgressObserver};
use crate::schema::*;

const READ_CHUNK: usize = 4 * 1024 * 1024;

/// Files excluded from `filtered_content_hash` and similarity (scene junk).
pub fn is_ignored(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".nfo") || lower.ends_with(".diz")
}

/// Stream the image once, computing md5/sha1/sha256 and emitting progress.
/// A directory (a folder opened as one build) hashes its track set instead —
/// see [`hash_dir`].
pub fn hash_image(path: &str, observer: &Arc<dyn ProgressObserver>) -> Result<ImageInfo> {
    let p = std::path::Path::new(path);
    if p.is_dir() {
        return hash_dir(p, observer);
    }
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    let file = File::open(path)?;
    let size = file.metadata()?.len();

    const ID: u64 = 0;
    observer.on_event(Event::CounterOpen {
        id: ID,
        label: "Hashing".into(),
        unit: "B".into(),
        total: Some(size as f64),
    });

    let mut hashers = ImageHashers::new();
    let done = hashers.consume(file, 0, ID, observer)?;
    observer.on_event(Event::CounterClose { id: ID });

    Ok(hashers.finish(name, done))
}

/// Identity for a folder opened as one build: the folder's importable files (its
/// track set — descriptors and sidecars like `.cue`/`.gdi` are excluded, so a
/// cue edit or a scan file doesn't change identity), concatenated in natural
/// name order ("Track 2" before "Track 10", i.e. disc order) and hashed as one
/// stream. Depends only on the member files' names and bytes, not the folder's
/// own name or location. The display name comes from the dump's own naming
/// where possible (see [`crate::folder_build_name`]).
fn hash_dir(root: &std::path::Path, observer: &Arc<dyn ProgressObserver>) -> Result<ImageInfo> {
    let name = crate::folder_build_name(root);
    let files = crate::dir_image_files(root);
    if files.is_empty() {
        return Err(crate::error::Error::Unsupported(root.to_string_lossy().into_owned()));
    }

    let mut total: u64 = 0;
    for f in &files {
        total += std::fs::metadata(f)?.len();
    }

    const ID: u64 = 0;
    observer.on_event(Event::CounterOpen {
        id: ID,
        label: "Hashing".into(),
        unit: "B".into(),
        total: Some(total as f64),
    });

    let mut hashers = ImageHashers::new();
    let mut done: u64 = 0;
    for f in &files {
        done = hashers.consume(File::open(f)?, done, ID, observer)?;
    }
    observer.on_event(Event::CounterClose { id: ID });

    Ok(hashers.finish(name, done))
}

/// The md5+sha1+sha256 triple an image identity is built from, fed one reader
/// at a time (a single image file, or each track of a folder build in turn).
struct ImageHashers {
    md5: Md5,
    sha1: Sha1,
    sha256: Sha256,
}

impl ImageHashers {
    fn new() -> Self {
        ImageHashers { md5: Md5::new(), sha1: Sha1::new(), sha256: Sha256::new() }
    }

    /// Stream `reader` into all three hashers, advancing the progress counter
    /// from `done`. Returns the new byte count.
    fn consume(
        &mut self,
        mut reader: impl Read,
        mut done: u64,
        counter_id: u64,
        observer: &Arc<dyn ProgressObserver>,
    ) -> Result<u64> {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            if observer.is_cancelled() {
                observer.on_event(Event::CounterClose { id: counter_id });
                return Err(crate::error::Error::Cancelled);
            }
            let n = reader.read(&mut buf)?;
            if n == 0 {
                return Ok(done);
            }
            self.md5.update(&buf[..n]);
            self.sha1.update(&buf[..n]);
            self.sha256.update(&buf[..n]);
            done += n as u64;
            observer.on_event(Event::Progress { id: counter_id, count: done as f64 });
        }
    }

    fn finish(self, name: String, size: u64) -> ImageInfo {
        ImageInfo {
            name,
            size,
            md5: hex::encode(self.md5.finalize()),
            sha1: hex::encode(self.sha1.finalize()),
            sha256: hex::encode(self.sha256.finalize()),
        }
    }
}

/// Content composites from the adapter's per-file sha1s.
///
/// `content_*` is a sha256 over each file's sha1 digest, sorted by digest value, so it
/// is independent of names, layout, order, and image container.
pub fn composites(files: &[RawFile]) -> Composites {
    let mut all: Vec<[u8; 20]> = Vec::new();
    let mut filtered: Vec<[u8; 20]> = Vec::new();
    let mut incomplete: u32 = 0;

    for f in files {
        // Archive members don't exist as far as identity is concerned: the
        // archive file's own sha1 already covers their bytes.
        if f.is_dir || f.in_archive {
            continue;
        }
        if f.unreadable {
            incomplete += 1;
        }
        let Some(sha1_hex) = f.sha1.as_deref() else { continue };
        let Some(bytes) = decode_sha1(sha1_hex) else { continue };
        all.push(bytes);
        if !is_ignored(&f.path) {
            filtered.push(bytes);
        }
    }

    Composites {
        content_hash: digest_of_set(&mut all),
        filtered_content_hash: digest_of_set(&mut filtered),
        hash_exe: None,
        most_recent_file: None,
        incomplete_files: incomplete,
    }
}

fn decode_sha1(hex_str: &str) -> Option<[u8; 20]> {
    let v = hex::decode(hex_str).ok()?;
    v.try_into().ok()
}

fn digest_of_set(digests: &mut [[u8; 20]]) -> Option<String> {
    if digests.is_empty() {
        return None;
    }
    digests.sort_unstable();
    let mut h = Sha256::new();
    for d in digests.iter() {
        h.update(d);
    }
    Some(hex::encode(h.finalize()))
}

/// Cheap precomputed query features.
pub fn structural(system: &str, files: &[RawFile]) -> Structural {
    let mut file_count = 0u64;
    let mut total_size = 0u64;
    let mut max_depth = 0u32;
    let mut ext_histogram: BTreeMap<String, u64> = BTreeMap::new();

    // Structural features describe the *listing* (what the tree shows), so
    // archive members count here — unlike composites, where the archive is
    // one opaque file.
    for f in files {
        let depth = f.path.trim_matches('/').split('/').count() as u32;
        max_depth = max_depth.max(depth);
        if f.is_dir {
            continue;
        }
        file_count = file_count.saturating_add(1);
        total_size = total_size.saturating_add(f.size.unwrap_or(0));
        if let Some(ext) = extension(&f.path) {
            *ext_histogram.entry(ext).or_insert(0) += 1;
        }
    }

    Structural { system: system.to_string(), file_count, total_size, max_depth, ext_histogram }
}

fn extension(path: &str) -> Option<String> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let dot = name.rfind('.')?;
    if dot == 0 {
        return None;
    }
    Some(name[dot + 1..].to_ascii_lowercase())
}

/// Title + maker + system + the full filename/path corpus, for server-side embedding.
pub fn text_doc(info: &DiscInfo, files: &[RawFile]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = &info.header.title {
        parts.push(t.clone());
    }
    if let Some(m) = &info.header.maker_id {
        parts.push(m.clone());
    }
    // PSP/PS3 carry title + serial in the SFO, not the header.
    if let Some(s) = &info.sfo {
        if let Some(t) = &s.title {
            parts.push(t.clone());
        }
        if let Some(id) = &s.disc_id {
            parts.push(id.clone());
        }
    }
    parts.push(info.system.clone());
    for f in files {
        parts.push(f.path.trim_matches('/').replace('/', " "));
    }
    parts.join(" ")
}

// ---- chunk signature + sidecar ----

const SIGNATURE_K: u32 = 128;
const SIGNATURE_BASE_SEED: u64 = 0x5ec0_de5e_ed5e_ed00;

/// MinHash signature over the build’s chunk multiset. None if no file was
/// chunked. The server recomputes an IDF/size-weighted signature from the raw chunks;
/// this is the cheap desktop-side approximation.
pub fn chunk_signature(files: &[RawFile]) -> Option<Signature> {
    let mut any = false;
    let mut mins = vec![u64::MAX; SIGNATURE_K as usize];
    let seeds: Vec<u64> = (0..SIGNATURE_K)
        .map(|i| splitmix(SIGNATURE_BASE_SEED ^ (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)))
        .collect();

    for f in files {
        for (hash, _len) in &f.chunks {
            any = true;
            for (i, seed) in seeds.iter().enumerate() {
                let h = splitmix(hash ^ seed);
                if h < mins[i] {
                    mins[i] = h;
                }
            }
        }
    }

    if !any {
        return None;
    }
    Some(Signature {
        kind: "minhash-v1".into(),
        k: SIGNATURE_K,
        seed: SIGNATURE_BASE_SEED,
        values: mins,
    })
}

/// Build-level byte-shingle resemblance signature: the element-wise minimum of
/// every large file’s OPH signature — exactly the OPH of the union of their
/// shingles. None if no file had one. Unlike the chunk signature this survives many
/// small *scattered* edits, where exact chunk hashes collapse.
pub fn resemblance_signature(files: &[RawFile]) -> Option<Signature> {
    let k = files.iter().find(|f| !f.shingle.is_empty()).map(|f| f.shingle.len())?;
    let mut mins = vec![u64::MAX; k];
    for f in files {
        if f.shingle.len() != k {
            continue; // skip stragglers from a mismatched profile
        }
        for (m, &v) in mins.iter_mut().zip(&f.shingle) {
            if v < *m {
                *m = v;
            }
        }
    }
    Some(Signature {
        kind: "oph-shingle-v1".into(),
        k: k as u32,
        seed: 0,
        values: mins,
    })
}

#[inline]
fn splitmix(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Compact binary chunk sidecar (`<sha256>.chunks`): per-file `(hash64, len)` lists,
/// retained for server-side IDF re-weighting and media diff.
///
/// Layout (LE): magic "CCK1", u32 file_count, then per file:
/// u16 path_len, path bytes, u32 n_chunks, n_chunks × (u64 hash, u32 len).
pub fn chunk_sidecar(files: &[RawFile]) -> Vec<u8> {
    let with_chunks: Vec<&RawFile> = files.iter().filter(|f| !f.chunks.is_empty()).collect();
    let mut out = Vec::new();
    out.extend_from_slice(b"CCK1");
    out.extend_from_slice(&(with_chunks.len() as u32).to_le_bytes());
    for f in with_chunks {
        let path = f.path.as_bytes();
        let plen = path.len().min(u16::MAX as usize) as u16;
        out.extend_from_slice(&plen.to_le_bytes());
        out.extend_from_slice(&path[..plen as usize]);
        out.extend_from_slice(&(f.chunks.len() as u32).to_le_bytes());
        for (hash, len) in &f.chunks {
            out.extend_from_slice(&hash.to_le_bytes());
            out.extend_from_slice(&len.to_le_bytes());
        }
    }
    out
}

// ---- tree building ----

#[derive(Default)]
struct DirBuild {
    date: Option<String>,
    size: Option<u64>,
    dirs: BTreeMap<String, DirBuild>,
    files: BTreeMap<String, Node>,
}

// Leave room for the surrounding record within serde_json's recursion limit.
const MAX_PATH_DEPTH: usize = 60;

/// Build the nested filesystem tree from the adapter's flat path list.
pub fn build_tree(files: &[RawFile]) -> Result<Vec<Node>> {
    // Validate the complete, archive-prefixed path before constructing any
    // recursive value (including one that would recurse when dropped on error).
    if files.iter().any(|f| f.path.split('/').filter(|s| !s.is_empty()).take(MAX_PATH_DEPTH + 1).count() > MAX_PATH_DEPTH) {
        return Err(crate::error::Error::Adapter("file path exceeds the depth limit".into()));
    }
    let mut root = DirBuild::default();

    for f in files {
        let comps: Vec<&str> = f.path.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();
        if comps.is_empty() {
            continue;
        }
        let (name, parents) = comps.split_last().unwrap();

        let mut cur = &mut root;
        for p in parents {
            cur = cur.dirs.entry((*p).to_string()).or_default();
        }

        if f.is_dir {
            let d = cur.dirs.entry((*name).to_string()).or_default();
            d.date = f.date.clone();
            d.size = f.size;
        } else {
            cur.files.insert(
                (*name).to_string(),
                Node::File {
                    name: (*name).to_string(),
                    date: f.date.clone(),
                    size: f.size,
                    md5: f.md5.clone(),
                    sha1: f.sha1.clone(),
                    sha256: f.sha256.clone(),
                    unreadable: f.unreadable,
                },
            );
        }
    }

    Ok(finish_dir(root))
}

fn finish_dir(mut d: DirBuild) -> Vec<Node> {
    // Directories first, then files; each alphabetical (BTreeMap keeps key order).
    let mut out: Vec<Node> = Vec::with_capacity(d.dirs.len() + d.files.len());
    for (name, sub) in std::mem::take(&mut d.dirs) {
        let mut date = sub.date.clone();
        let mut size = sub.size;
        let mut md5 = None;
        let mut sha1 = None;
        let mut sha256 = None;
        // An archive listed as a directory is both a file (its own record) and
        // a dir (its members' paths): merge into one dir node carrying the
        // file's metadata instead of showing same-named siblings.
        if let Some(Node::File { date: fd, size: fs, md5: fm, sha1: f1, sha256: f2, .. }) =
            d.files.remove(&name)
        {
            date = date.or(fd);
            size = size.or(fs);
            (md5, sha1, sha256) = (fm, f1, f2);
        }
        out.push(Node::Dir { name, date, size, md5, sha1, sha256, children: finish_dir(sub) });
    }
    out.extend(d.files.into_values());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Valid 40-hex (20-byte) sha1 digests.
    const A: &str = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
    const B: &str = "0000000000000000000000000000000000000001";
    const C: &str = "ffffffffffffffffffffffffffffffffffffffff";

    fn file(path: &str, sha1: &str) -> RawFile {
        RawFile {
            path: path.into(),
            is_dir: false,
            date: None,
            size: Some(10),
            md5: None,
            sha1: Some(sha1.into()),
            sha256: None,
            unreadable: false,
            in_archive: false,
            chunks: vec![],
            shingle: vec![],
        }
    }

    fn dir(path: &str) -> RawFile {
        RawFile {
            path: path.into(),
            is_dir: true,
            date: None,
            size: None,
            md5: None,
            sha1: None,
            sha256: None,
            unreadable: false,
            in_archive: false,
            chunks: vec![],
            shingle: vec![],
        }
    }

    fn member(path: &str, sha1: &str) -> RawFile {
        RawFile { in_archive: true, ..file(path, sha1) }
    }

    #[test]
    fn content_hash_ignores_order_and_names() {
        let a = vec![file("/X.BIN", A), file("/Y.BIN", B)];
        let b = vec![file("/deep/path/other.dat", B), file("/z", A)];
        assert_eq!(composites(&a).content_hash, composites(&b).content_hash);

        let c = vec![file("/X.BIN", A), file("/Y.BIN", C)];
        assert_ne!(composites(&a).content_hash, composites(&c).content_hash);
    }

    #[test]
    fn filtered_hash_ignores_scene_junk() {
        let base = vec![file("/GAME.BIN", A)];
        let with_nfo = vec![file("/GAME.BIN", A), file("/readme.nfo", B)];
        // strict hash changes, filtered hash does not
        assert_ne!(composites(&base).content_hash, composites(&with_nfo).content_hash);
        assert_eq!(
            composites(&base).filtered_content_hash,
            composites(&with_nfo).filtered_content_hash
        );
    }

    #[test]
    fn is_ignored_matches_nfo_diz_case_insensitive() {
        assert!(is_ignored("/FILE.NFO"));
        assert!(is_ignored("/sub/x.diz"));
        assert!(!is_ignored("/GAME.BIN"));
        assert!(!is_ignored("/nfo.bin"));
    }

    #[test]
    fn incomplete_files_counted() {
        let mut bad = file("/A", A);
        bad.unreadable = true;
        assert_eq!(composites(&[bad, file("/B", B)]).incomplete_files, 1);
    }

    #[test]
    fn structural_counts_sizes_and_extensions() {
        let files = vec![dir("/D"), file("/D/A.BIN", A), file("/D/B.iso", B)];
        let s = structural("PSX", &files);
        assert_eq!(s.system, "PSX");
        assert_eq!(s.file_count, 2); // directory excluded
        assert_eq!(s.total_size, 20);
        assert_eq!(s.ext_histogram.get("bin"), Some(&1));
        assert_eq!(s.ext_histogram.get("iso"), Some(&1));
        assert!(s.max_depth >= 2);
    }

    #[test]
    fn build_tree_nests_paths() {
        let tree = build_tree(&[file("/DATA/SUB/x.bin", A), file("/root.bin", B)]).unwrap();
        let names: Vec<&str> = tree.iter().map(|n| n.name()).collect();
        assert!(names.contains(&"DATA"), "got {names:?}");
        assert!(names.contains(&"root.bin"), "got {names:?}");
        let data = tree.iter().find(|n| n.name() == "DATA").unwrap();
        match data {
            Node::Dir { children, .. } => assert_eq!(children[0].name(), "SUB"),
            _ => panic!("DATA should be a directory"),
        }
    }

    #[test]
    fn archive_members_do_not_change_composites_but_count_structurally() {
        let base = vec![file("/GAME.BIN", A), file("/PATCH.ZIP", B)];
        let mut bad_member = member("/PATCH.ZIP/broken.dat", C);
        bad_member.unreadable = true;
        let listed = vec![
            file("/GAME.BIN", A),
            file("/PATCH.ZIP", B),
            member("/PATCH.ZIP/deep/readme.txt", C),
            bad_member,
        ];
        // The archive contributes exactly its own sha1, members nothing at all —
        // not even to the incomplete-files count.
        assert_eq!(composites(&base).content_hash, composites(&listed).content_hash);
        assert_eq!(
            composites(&base).filtered_content_hash,
            composites(&listed).filtered_content_hash
        );
        assert_eq!(composites(&listed).incomplete_files, 0);

        // Structural features describe the listing, so members DO count there.
        let s = structural("PSX", &listed);
        assert_eq!(s.file_count, 4);
        assert_eq!(s.total_size, 40);
        assert_eq!(s.ext_histogram.get("txt"), Some(&1));
        assert_eq!(s.max_depth, 3);
    }

    #[test]
    fn build_tree_merges_archive_file_into_its_dir() {
        let mut zip = file("/DATA/PATCH.ZIP", A);
        zip.md5 = Some("aabb".into());
        zip.sha256 = Some("ccdd".into());
        let tree = build_tree(&[
            zip,
            member("/DATA/PATCH.ZIP/src/main.c", B),
            member("/DATA/PATCH.ZIP/title.png", C),
        ]).unwrap();
        let Node::Dir { children: data, .. } = &tree[0] else { panic!("DATA should be a dir") };
        // One node for the archive — a dir carrying the file's own hashes/size.
        assert_eq!(data.len(), 1);
        match &data[0] {
            Node::Dir { name, size, md5, sha1, sha256, children, .. } => {
                assert_eq!(name, "PATCH.ZIP");
                assert_eq!(*size, Some(10));
                assert_eq!(md5.as_deref(), Some("aabb"));
                assert_eq!(sha1.as_deref(), Some(A));
                assert_eq!(sha256.as_deref(), Some("ccdd"));
                let names: Vec<&str> = children.iter().map(|n| n.name()).collect();
                assert_eq!(names, vec!["src", "title.png"]);
            }
            _ => panic!("PATCH.ZIP should have become a dir node"),
        }
    }

    #[test]
    fn tree_depth_is_bounded_before_construction() {
        for depth in [MAX_PATH_DEPTH + 1, 10_000] {
            let path = vec!["nested.zip"; depth].join("/");
            assert!(build_tree(&[file("ordinary", A), member(&path, B)]).is_err());
            assert!(build_tree(&[dir(&path)]).is_err());
        }
        let path = vec!["long Unicode name 日本語"; MAX_PATH_DEPTH].join("//");
        let files = [file(&path, A)];
        let record = BuildRecord {
            record_schema_version: RECORD_SCHEMA_VERSION,
            fingerprint_profile: FINGERPRINT_PROFILE.into(),
            image: ImageInfo { name: "disc".into(), size: 0, md5: "".into(), sha1: "".into(), sha256: "".into() },
            info: DiscInfo::default(), composites: composites(&files),
            structural: structural("PSX", &files), text_doc: "".into(),
            contents: build_tree(&files).unwrap(), media: vec![], exe_fp: None,
            chunk_signature: None, resemblance: None, assets: None, asset_profile: ASSET_PROFILE,
        };
        let json = serde_json::to_vec(&record).unwrap();
        let decoded: BuildRecord = serde_json::from_slice(&json).unwrap();
        assert_eq!(serde_json::to_vec(&decoded.clone()).unwrap(), json);
    }

    #[test]
    fn chunk_signature_is_deterministic_and_setlike() {
        let mut a = file("/A", A);
        a.chunks = vec![(1, 10), (2, 20), (3, 30)];
        let mut b = file("/elsewhere", B);
        b.chunks = vec![(3, 30), (2, 20), (1, 10)]; // same chunk set, different order/name
        let sa = chunk_signature(&[a]).unwrap();
        let sb = chunk_signature(&[b]).unwrap();
        assert_eq!(sa.values, sb.values); // MinHash depends only on the chunk set
        assert_eq!(sa.k as usize, sa.values.len());
        assert!(chunk_signature(&[file("/no-chunks", C)]).is_none());
    }

    #[test]
    fn resemblance_signature_is_elementwise_min_over_files() {
        let mut a = file("/big_a", A);
        a.shingle = vec![5, 9, 2, 8];
        let mut b = file("/big_b", B);
        b.shingle = vec![3, 9, 7, 1];
        let small = file("/small", C); // no shingle → ignored
        let s = resemblance_signature(&[a, small, b]).unwrap();
        assert_eq!(s.kind, "oph-shingle-v1");
        assert_eq!(s.k, 4);
        assert_eq!(s.values, vec![3, 9, 2, 1]); // per-slot min of the two files
        assert!(resemblance_signature(&[file("/none", A)]).is_none());
    }

    #[test]
    fn chunk_sidecar_has_magic_header() {
        let mut a = file("/A", A);
        a.chunks = vec![(7, 5)];
        let s = chunk_sidecar(&[a]);
        assert_eq!(&s[..4], b"CCK1");
        // file_count = 1 in the next 4 LE bytes
        assert_eq!(u32::from_le_bytes(s[4..8].try_into().unwrap()), 1);
    }
}
