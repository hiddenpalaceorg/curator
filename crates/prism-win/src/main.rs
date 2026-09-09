//! Prism native Windows GUI (windows-rs).
//!
//! A classic Win32 app calling `prism-core` in-process: a TreeView of the analyzed
//! filesystem on the left, the DAT/XML document on the right, a progress bar + status
//! bar at the bottom, and File ▸ Open. Analysis runs on a worker thread; progress and
//! completion are marshaled back to the UI thread via `PostMessageW`.
//!
//! This file is `#[cfg(windows)]`-gated; on other hosts it builds to a stub so the
//! crate is still well-formed. Compile-check from macOS with:
//!   cargo check --manifest-path crates/prism-win/Cargo.toml --target x86_64-pc-windows-gnu

#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(not(windows))]
fn main() {
    eprintln!("prism-win targets Windows; build with --target x86_64-pc-windows-*");
}

#[cfg(windows)]
fn main() -> windows::core::Result<()> {
    // `prism-win --cli <command…>` runs the shared prism CLI instead of
    // opening a window: attach to the launching console and delegate. Note the
    // exe is a GUI-subsystem binary, so an interactive cmd/PowerShell prompt
    // returns immediately; output still lands in the console, and redirection
    // (`> file`, pipes) behaves normally.
    let mut args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--cli") {
        args.remove(1);
        app::attach_console();
        std::process::exit(prism_cli::run(args, app::cli_fallback_adapter()));
    }
    let debug = args.iter().skip(1).any(|arg| arg == "--debug");
    app::run(debug)
}

#[cfg(windows)]
mod app {
    use std::collections::{HashMap, VecDeque};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use prism_core::adapter::AdapterCommand;
    use prism_core::db::LibrarySort;
    use prism_core::summary::{self, Section};
    use prism_core::{
        render, Analyzer, AssetRef, BuildRecord, Config, Event, Node, ProgressObserver, Reader,
    };

    use windows::core::{w, PCWSTR, PWSTR, Result};
    use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, DEFAULT_GUI_FONT};
    use windows::Win32::Networking::WinHttp::*;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
    use windows::Win32::UI::Controls::Dialogs::{
        GetOpenFileNameW, GetSaveFileNameW, OFN_FILEMUSTEXIST, OFN_OVERWRITEPROMPT,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    use windows::Win32::UI::Controls::{
        InitCommonControlsEx, ICC_BAR_CLASSES, ICC_LISTVIEW_CLASSES, ICC_PROGRESS_CLASS,
        ICC_TREEVIEW_CLASSES, INITCOMMONCONTROLSEX, LVCFMT_LEFT, LVCOLUMNW, LVGA_HEADER_LEFT,
        LVGF_ALIGN, LVGF_GROUPID, LVGF_HEADER, LVGROUP, LVITEMW, LVCF_SUBITEM, LVCF_TEXT,
        LVCF_WIDTH, LVIF_GROUPID, LVIF_TEXT, LVM_DELETEALLITEMS, LVM_ENABLEGROUPVIEW,
        LVM_GETITEMTEXTW, LVM_INSERTCOLUMNW, LVM_INSERTGROUP, LVM_INSERTITEMW, LVM_REMOVEALLGROUPS,
        LVM_SETCOLUMNWIDTH, LVM_SETEXTENDEDLISTVIEWSTYLE, LVM_SETITEMW, LVS_EX_DOUBLEBUFFER,
        LVS_EX_FULLROWSELECT, LVS_EX_LABELTIP, LVS_NOCOLUMNHEADER, LVS_REPORT, LVS_SINGLESEL,
        LVN_COLUMNCLICK, NMHDR, NMITEMACTIVATE, NMLISTVIEW,
        NMTREEVIEWW, NM_DBLCLK, PBM_SETPOS, PBM_SETRANGE32, TVINSERTSTRUCTW, TVINSERTSTRUCTW_0,
        TVITEMW, TVIF_PARAM, TVIF_TEXT, TVI_LAST, TVI_ROOT, TVM_DELETEITEM, TVM_INSERTITEMW,
        TVN_SELCHANGEDW, TVS_HASBUTTONS, TVS_HASLINES, TVS_LINESATROOT,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows::Win32::UI::Shell::{
        DefSubclassProc, DragAcceptFiles, DragFinish, DragQueryFileW, FileOpenDialog,
        IFileOpenDialog, SetWindowSubclass, ShellExecuteW, FOS_FORCEFILESYSTEM,
        FOS_PICKFOLDERS, HDROP, SIGDN_FILESYSPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::*;

    // ---- ids & custom messages ----
    const IDM_OPEN: usize = 1;
    const IDM_OPEN_FOLDER: usize = 2;
    const IDM_CANCEL: usize = 3;
    const IDM_EXIT: usize = 4;
    const IDM_SIMILAR: usize = 5;
    const IDM_SUBMIT: usize = 6;
    const IDM_VIEW_OVERVIEW: usize = 7;
    const IDM_VIEW_XML: usize = 8;
    const IDM_VIEW_JSON: usize = 9;
    const IDM_EXPORT: usize = 10;
    const IDM_BROWSE: usize = 11;
    const IDM_VIEW_ASSETS: usize = 12;
    const IDM_OPEN_DIR_BUILD: usize = 13;
    const IDM_REANALYZE: usize = 14;
    const IDM_RECENT_BASE: usize = 2000;
    const MAX_RECENT: u32 = 15;

    /// What the right-hand document pane is showing. Overview/Selection/Assets render
    /// in the grouped ListView; Xml/Json render as text in the EDIT control.
    #[derive(Clone, Copy, PartialEq)]
    enum DocView {
        Overview,
        Selection,
        Assets,
        Xml,
        Json,
    }

    const WM_APP_PROGRESS: u32 = WM_APP + 1;
    const WM_APP_DONE: u32 = WM_APP + 2;
    const WM_APP_SERVICE: u32 = WM_APP + 3; // similarity / submit result (boxed String)
    const WM_APP_IMPORT_DONE: u32 = WM_APP + 4; // batch folder-import summary (boxed String)
    const WM_APP_LIB_REFRESH: u32 = WM_APP + 5; // a build was imported — refresh library mode

    const STATUS_H: i32 = 22;
    const PROGRESS_H: i32 = 16;

    /// A progress event, owned and `Send`, queued for the UI thread.
    enum UiEvent {
        Batch { index: u64, total: u64, name: String },
        Open { id: u64, label: String, total: Option<f64> },
        Progress { id: u64, count: f64 },
        Close { id: u64 },
        Message(String),
    }

    /// Result of a worker analysis, handed to the UI thread via WM_APP_DONE.
    struct AnalysisDone {
        record: BuildRecord,
        xml: String,
        json: String,
        from_cache: bool,
    }

    /// Per-window state (UI thread only; raw HWNDs are not `Send`).
    struct AppState {
        adapter: AdapterCommand,
        data_dir: Option<PathBuf>,
        analyzer: Arc<Mutex<Option<Analyzer>>>,
        tree: HWND,
        edit: HWND,
        /// Grouped key/value view for Overview + per-file Selection (overlaps `edit`).
        list: HWND,
        status: HWND,
        progress: HWND,
        events: Arc<Mutex<VecDeque<UiEvent>>>,
        cancel: Arc<AtomicBool>,
        totals: HashMap<u64, f64>,
        working: bool,
        /// True during a recursive folder import (vs. a single analyze): keeps the
        /// "Importing x of y" status from being overwritten by per-file counter labels.
        importing: bool,
        /// The current "Importing x of y: name" line, so per-file progress can append a %.
        import_base: String,
        /// Canonical JSON of the loaded build (for similarity/submit), if any.
        last_json: Option<String>,
        /// Image sha256 of the loaded build (keys the asset-upload endpoints).
        last_sha: Option<String>,
        /// The loaded build's viewable assets; `assets_extracted` distinguishes
        /// "extraction ran, nothing viewable" from "extraction never ran".
        assets: Vec<AssetRef>,
        assets_extracted: bool,
        /// Assets-view ListView row → index into `assets` (rows flatten kind groups).
        asset_rows: Vec<usize>,
        /// Document-pane content, by view. `view` selects which one is shown.
        view: DocView,
        doc_overview: Vec<Section>,
        doc_xml: String,
        /// Per-file metadata, indexed by the tree item's lParam.
        node_sections: Vec<Section>,
        /// Sections for the currently selected tree node.
        selected_sections: Vec<Section>,
        /// Web service base URL (PRISM_WEB_URL, default https://hiddenpalace.org).
        web_url: String,
        /// Optional moderation secret (PRISM_MODERATION_TOKEN). When set, a submit
        /// is auto-accepted so it replaces the live build instead of waiting in the queue.
        moderation_token: String,
        /// The "Recent" submenu and the sha256s backing its items (by position).
        recent_menu: HMENU,
        recent: Vec<String>,

        // ---- library mode (in-app browser; non-modal, usable during import) ----
        /// When true, the main pane shows the library list instead of the build tree/doc.
        library_mode: bool,
        lib_search: HWND,
        lib_combo: HWND,
        lib_list: HWND,
        /// sha256 backing each library row, by index.
        lib_rows: Vec<String>,
        /// Systems in the filter combo (combo index 0 = "All systems").
        lib_systems: Vec<String>,
        lib_sort: LibrarySort,
        lib_desc: bool,
        /// Lock-free read side (own DB connection + record cache), so browsing *and*
        /// opening a build work while an import holds the analyzer (WAL → concurrent).
        reader: Option<Reader>,
    }

    /// Construction config passed through `CreateWindowExW`'s lpParam.
    struct InitConfig {
        adapter: AdapterCommand,
        data_dir: Option<PathBuf>,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Resolve the adapter: env override → bundle next to the exe (`adapter\prism-adapter*`)
    /// → adapter embedded in this exe (single-file build, extracted once) →
    /// `PRISM_ADAPTER_DIR` → the dev `ps2exe-adapter` uv project.
    fn resolve_adapter() -> AdapterCommand {
        if let Ok(bin) = std::env::var("PRISM_ADAPTER_BIN") {
            return AdapterCommand::bin(&bin);
        }
        if let Some(cmd) = cli_fallback_adapter() {
            return cmd;
        }
        let dir = std::env::var("PRISM_ADAPTER_DIR").unwrap_or_else(|_| "ps2exe-adapter".to_string());
        AdapterCommand::uv(&dir)
    }

    /// The GUI-specific part of adapter resolution — the bundle next to the exe,
    /// then the adapter embedded in this exe. Handed to `--cli` mode as its
    /// fallback for when no flag or env var picks an adapter.
    pub fn cli_fallback_adapter() -> Option<AdapterCommand> {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for name in ["prism-adapter.exe", "prism-adapter.cmd", "prism-adapter.bat", "prism-adapter"] {
                    let p = dir.join("adapter").join(name);
                    if p.exists() {
                        return Some(AdapterCommand::bin(&p.to_string_lossy()));
                    }
                }
            }
        }
        #[cfg(embed_adapter)]
        {
            if let Some(p) = extract_embedded_adapter() {
                return Some(AdapterCommand::bin(&p.to_string_lossy()));
            }
        }
        None
    }

    /// Console attach for `--cli` mode. A `windows_subsystem = "windows"` exe
    /// starts detached with NULL std handles, so adopt the launching console
    /// (or create one when started outside any), then point still-unset std
    /// handles at it. Handles the parent redirected (`> file`, pipes) are
    /// inherited as-is and stay untouched.
    pub fn attach_console() {
        use std::os::windows::io::IntoRawHandle;
        use windows::Win32::System::Console::{
            AllocConsole, AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS,
            STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        };
        unsafe {
            if AttachConsole(ATTACH_PARENT_PROCESS).is_err() && AllocConsole().is_err() {
                return; // headless; std writes will fail silently
            }
            for (slot, device) in [
                (STD_INPUT_HANDLE, "CONIN$"),
                (STD_OUTPUT_HANDLE, "CONOUT$"),
                (STD_ERROR_HANDLE, "CONOUT$"),
            ] {
                let unset = GetStdHandle(slot).map(|h| h.0.is_null()).unwrap_or(true);
                if unset {
                    if let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).open(device) {
                        // Deliberately leaked: a std handle lives for the process.
                        let _ = SetStdHandle(slot, HANDLE(f.into_raw_handle()));
                    }
                }
            }
        }
    }

    /// The adapter binary frozen into this exe at build time (single-file distribution).
    /// Enabled by build.rs when `PRISM_ADAPTER_EXE` points at a prebuilt adapter.
    #[cfg(embed_adapter)]
    static EMBEDDED_ADAPTER: &[u8] = include_bytes!(env!("PRISM_EMBEDDED_ADAPTER"));

    /// Write the embedded adapter to a per-version cache path under TEMP and return it;
    /// skipped if already present. Keyed by GUI version + byte length so an updated build
    /// re-extracts instead of reusing a stale adapter.
    #[cfg(embed_adapter)]
    fn extract_embedded_adapter() -> Option<PathBuf> {
        use std::io::Write;
        let dir = std::env::temp_dir().join("prism");
        std::fs::create_dir_all(&dir).ok()?;
        let exe = dir.join(format!(
            "prism-adapter-{}-{}.exe",
            env!("CARGO_PKG_VERSION"),
            EMBEDDED_ADAPTER.len()
        ));
        if !exe.exists() {
            // Write to a pid-unique temp then rename, so concurrent launches don't tear.
            let tmp = dir.join(format!("prism-adapter.{}.tmp", std::process::id()));
            {
                let mut f = std::fs::File::create(&tmp).ok()?;
                f.write_all(EMBEDDED_ADAPTER).ok()?;
                f.flush().ok()?;
            }
            let _ = std::fs::rename(&tmp, &exe);
            let _ = std::fs::remove_file(&tmp);
        }
        exe.exists().then_some(exe)
    }

    /// Icon resource 1, embedded from prism.ico by build.rs via prism.rc.
    const APP_ICON_ID: PCWSTR = PCWSTR(1 as *const u16);

    pub fn run(debug: bool) -> Result<()> {
        unsafe {
            // Apartment-threaded COM for the IFileDialog folder picker.
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);

            let _ = InitCommonControlsEx(&INITCOMMONCONTROLSEX {
                dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
                dwICC: ICC_TREEVIEW_CLASSES | ICC_BAR_CLASSES | ICC_PROGRESS_CLASS
                    | ICC_LISTVIEW_CLASSES,
            });

            let hinstance = GetModuleHandleW(None)?;
            let class_name = w!("PrismMainWindow");

            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: hinstance.into(),
                lpszClassName: class_name,
                hCursor: LoadCursorW(None, IDC_ARROW)?,
                hIcon: LoadIconW(hinstance, APP_ICON_ID).unwrap_or_default(),
                // COLOR_WINDOW (5) + 1, the conventional window-background brush.
                hbrBackground: HBRUSH(6 as *mut core::ffi::c_void),
                ..Default::default()
            };
            RegisterClassW(&wc);

            let mut adapter = resolve_adapter();
            if debug {
                let log = std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join("prism-debug.log");
                adapter = adapter.with_debug_log(log);
            }
            let init = Box::new(InitConfig { adapter, data_dir: None });

            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                w!("Prism"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                980,
                640,
                None,
                None,
                hinstance,
                Some(Box::into_raw(init) as *const core::ffi::c_void),
            )?;

            // The Windows 10 taskbar draws the window's big icon at 24px times the DPI
            // scale and never picks the matching .ico frame itself, it only shrinks the
            // 32px HICON, which blurs. Hand it a big icon loaded at exactly that size
            // (LoadImageW picks the best frame) and a metric-sized small one for the
            // title bar. Alt-Tab badges get the 24px icon too, which they render fine.
            let dpi = GetDpiForWindow(hwnd) as i32;
            let taskbar = 24 * dpi / 96;
            if let Ok(big) = LoadImageW(hinstance, APP_ICON_ID, IMAGE_ICON, taskbar, taskbar, LR_DEFAULTCOLOR) {
                let _ = SendMessageW(hwnd, WM_SETICON, WPARAM(ICON_BIG as usize), LPARAM(big.0 as isize));
            }
            let small = GetSystemMetricsForDpi(SM_CXSMICON, dpi as u32);
            if let Ok(sm) = LoadImageW(hinstance, APP_ICON_ID, IMAGE_ICON, small, small, LR_DEFAULTCOLOR) {
                let _ = SendMessageW(hwnd, WM_SETICON, WPARAM(ICON_SMALL as usize), LPARAM(sm.0 as isize));
            }

            let _ = ShowWindow(hwnd, SW_SHOW);

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        Ok(())
    }

    unsafe fn state<'a>(hwnd: HWND) -> Option<&'a mut AppState> {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut AppState;
        ptr.as_mut()
    }

    extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_CREATE => {
                    on_create(hwnd, lparam);
                    LRESULT(0)
                }
                WM_SIZE => {
                    if let Some(st) = state(hwnd) {
                        layout(hwnd, st);
                    }
                    LRESULT(0)
                }
                WM_COMMAND => {
                    let id = (wparam.0 & 0xffff) as usize;
                    let code = ((wparam.0 >> 16) & 0xffff) as u32;
                    if (id == IDC_LIB_SEARCH && code == EN_CHANGE)
                        || (id == IDC_LIB_COMBO && code == CBN_SELCHANGE)
                    {
                        refresh_library(hwnd);
                    } else {
                        on_command(hwnd, id);
                    }
                    LRESULT(0)
                }
                WM_NOTIFY => {
                    on_notify(hwnd, lparam);
                    DefWindowProcW(hwnd, msg, wparam, lparam)
                }
                WM_APP_PROGRESS => {
                    drain_progress(hwnd);
                    LRESULT(0)
                }
                WM_APP_DONE => {
                    on_done(hwnd, lparam);
                    LRESULT(0)
                }
                WM_APP_SERVICE => {
                    on_service_result(hwnd, lparam);
                    LRESULT(0)
                }
                WM_APP_IMPORT_DONE => {
                    on_import_done(hwnd, lparam);
                    LRESULT(0)
                }
                WM_APP_LIB_REFRESH => {
                    // An item was imported; if the library is on screen, reflect it live.
                    if state(hwnd).map(|st| st.library_mode).unwrap_or(false) {
                        refresh_library(hwnd);
                    }
                    LRESULT(0)
                }
                WM_DROPFILES => {
                    on_drop(hwnd, wparam);
                    LRESULT(0)
                }
                WM_CLOSE => {
                    // Trip the cancel flag so any in-flight worker stops cooperatively *before*
                    // WM_DESTROY frees AppState (and the Arcs it shares with the worker). The
                    // worker may still post WM_APP_DONE to the now-dead window; that post fails
                    // and is reclaimed by fix #2, so no leak. We don't join (would block the UI).
                    if let Some(st) = state(hwnd) {
                        st.cancel.store(true, Ordering::SeqCst);
                    }
                    let _ = DestroyWindow(hwnd);
                    LRESULT(0)
                }
                WM_DESTROY => {
                    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut AppState;
                    if !ptr.is_null() {
                        drop(Box::from_raw(ptr));
                        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                    }
                    PostQuitMessage(0);
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

    unsafe fn on_create(hwnd: HWND, lparam: LPARAM) {
        let cs = lparam.0 as *const CREATESTRUCTW;
        let init = Box::from_raw((*cs).lpCreateParams as *mut InitConfig);
        let hinst = (*cs).hInstance;

        let child = WS_CHILD | WS_VISIBLE | WS_BORDER;
        let tree = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("SysTreeView32"),
            PCWSTR::null(),
            WINDOW_STYLE(child.0 | TVS_HASLINES | TVS_HASBUTTONS | TVS_LINESATROOT),
            0, 0, 0, 0, hwnd, None, hinst, None,
        )
        .unwrap_or_default();

        let edit = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("EDIT"),
            PCWSTR::null(),
            WINDOW_STYLE(child.0 | (ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL) as u32)
                | WS_VSCROLL
                | WS_HSCROLL,
            0, 0, 0, 0, hwnd, None, hinst, None,
        )
        .unwrap_or_default();
        // Lift the EDIT control's text cap (default ~32KB for multiline) so large DAT/XML/JSON
        // documents aren't silently truncated. wparam 0 means "maximum".
        let _ = SendMessageW(
            edit,
            windows::Win32::UI::Controls::EM_SETLIMITTEXT,
            WPARAM(0),
            LPARAM(0),
        );

        // Grouped key/value view (overlaps `edit`; only one is visible at a time).
        let list = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("SysListView32"),
            PCWSTR::null(),
            WINDOW_STYLE(child.0 | (LVS_REPORT | LVS_NOCOLUMNHEADER) as u32),
            0, 0, 0, 0, hwnd, None, hinst, None,
        )
        .unwrap_or_default();
        let _ = SendMessageW(
            list,
            LVM_SETEXTENDEDLISTVIEWSTYLE,
            WPARAM((LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER | LVS_EX_LABELTIP) as usize),
            LPARAM((LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER | LVS_EX_LABELTIP) as isize),
        );
        let _ = SendMessageW(list, LVM_ENABLEGROUPVIEW, WPARAM(1), LPARAM(0));
        // Two columns: field name (col 0, the item text) + value (col 1, subitem 1).
        // Headers are hidden (LVS_NOCOLUMNHEADER); widths are finalized in layout().
        for (idx, title, cx) in [(0i32, w!("Field"), 150i32), (1i32, w!("Value"), 360i32)] {
            let mut col = LVCOLUMNW::default();
            col.mask = LVCF_TEXT | LVCF_WIDTH | LVCF_SUBITEM;
            col.fmt = LVCFMT_LEFT;
            col.cx = cx;
            col.iSubItem = idx;
            col.pszText = PWSTR(title.as_ptr() as *mut u16);
            let _ = SendMessageW(list, LVM_INSERTCOLUMNW, WPARAM(idx as usize), LPARAM(&col as *const _ as isize));
        }
        // Hidden until a build loads; apply_view() reveals it for Overview/Selection.
        let _ = ShowWindow(list, SW_HIDE);

        let status = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("msctls_statusbar32"),
            PCWSTR::null(),
            child,
            0, 0, 0, 0, hwnd, None, hinst, None,
        )
        .unwrap_or_default();

        let progress = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("msctls_progress32"),
            PCWSTR::null(),
            child,
            0, 0, 0, 0, hwnd, None, hinst, None,
        )
        .unwrap_or_default();

        // Library-mode controls (search box + system filter + list); hidden until the
        // user switches to library mode. They overlay the same content area as the tree/doc.
        let lib_search = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("EDIT"),
            PCWSTR::null(),
            WINDOW_STYLE(child.0 | WS_BORDER.0 | ES_AUTOHSCROLL as u32),
            0, 0, 0, 0, hwnd,
            HMENU(IDC_LIB_SEARCH as *mut core::ffi::c_void), hinst, None,
        )
        .unwrap_or_default();
        let lib_combo = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("COMBOBOX"),
            PCWSTR::null(),
            WINDOW_STYLE(child.0 | WS_VSCROLL.0 | CBS_DROPDOWNLIST as u32),
            0, 0, 0, 0, hwnd,
            HMENU(IDC_LIB_COMBO as *mut core::ffi::c_void), hinst, None,
        )
        .unwrap_or_default();
        let lib_list = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("SysListView32"),
            PCWSTR::null(),
            WINDOW_STYLE(child.0 | (LVS_REPORT | LVS_SINGLESEL) as u32),
            0, 0, 0, 0, hwnd,
            HMENU(IDC_LIB_LIST as *mut core::ffi::c_void), hinst, None,
        )
        .unwrap_or_default();
        let _ = SendMessageW(
            lib_list,
            LVM_SETEXTENDEDLISTVIEWSTYLE,
            WPARAM((LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER | LVS_EX_LABELTIP) as usize),
            LPARAM((LVS_EX_FULLROWSELECT | LVS_EX_DOUBLEBUFFER | LVS_EX_LABELTIP) as isize),
        );
        lib_add_columns(lib_list);
        for h in [lib_search, lib_combo, lib_list] {
            let _ = ShowWindow(h, SW_HIDE);
        }

        let font = GetStockObject(DEFAULT_GUI_FONT);
        for h in [tree, edit, list, status, lib_search, lib_combo, lib_list] {
            SendMessageW(h, WM_SETFONT, WPARAM(font.0 as usize), LPARAM(1));
        }

        // Drag-and-drop: the panes cover the client area, so accept drops on them and
        // subclass them to forward WM_DROPFILES to the main window.
        DragAcceptFiles(hwnd, true);
        for h in [tree, edit, list, lib_list] {
            DragAcceptFiles(h, true);
            let _ = SetWindowSubclass(h, Some(drop_subclass), 1, 0);
        }

        let recent_menu = build_menu(hwnd);

        let st = Box::new(AppState {
            adapter: init.adapter.clone(),
            data_dir: init.data_dir.clone(),
            analyzer: Arc::new(Mutex::new(None)),
            tree,
            edit,
            list,
            status,
            progress,
            events: Arc::new(Mutex::new(VecDeque::new())),
            cancel: Arc::new(AtomicBool::new(false)),
            totals: HashMap::new(),
            working: false,
            importing: false,
            import_base: String::new(),
            last_json: None,
            last_sha: None,
            assets: Vec::new(),
            assets_extracted: false,
            asset_rows: Vec::new(),
            view: DocView::Overview,
            doc_overview: Vec::new(),
            doc_xml: String::new(),
            node_sections: Vec::new(),
            selected_sections: Vec::new(),
            web_url: std::env::var("PRISM_WEB_URL")
                .unwrap_or_else(|_| "https://hiddenpalace.org".to_string()),
            moderation_token: std::env::var("PRISM_MODERATION_TOKEN").unwrap_or_default(),
            recent_menu,
            recent: Vec::new(),
            library_mode: false,
            lib_search,
            lib_combo,
            lib_list,
            lib_rows: Vec::new(),
            lib_systems: Vec::new(),
            lib_sort: LibrarySort::Date,
            lib_desc: true,
            reader: None,
        });
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, Box::into_raw(st) as isize);

        set_status(hwnd, "Open — or drag in — a disc image, container, or folder.");
        if let Some(st) = state(hwnd) {
            layout(hwnd, st);
        }
        refresh_recent(hwnd);
    }

    unsafe fn build_menu(hwnd: HWND) -> HMENU {
        let menu = CreateMenu().unwrap_or_default();
        let file = CreatePopupMenu().unwrap_or_default();
        let recent = CreatePopupMenu().unwrap_or_default();
        let _ = AppendMenuW(file, MF_STRING, IDM_OPEN, w!("&Open Image…\tCtrl+O"));
        let _ = AppendMenuW(file, MF_STRING, IDM_OPEN_DIR_BUILD, w!("Open Folder as &Build…"));
        let _ = AppendMenuW(file, MF_STRING, IDM_REANALYZE, w!("&Re-analyze Image (fresh)…"));
        let _ = AppendMenuW(file, MF_STRING, IDM_OPEN_FOLDER, w!("&Import Folder (recursive)…"));
        let _ = AppendMenuW(file, MF_POPUP, recent.0 as usize, w!("Open &Recent"));
        let _ = AppendMenuW(file, MF_STRING, IDM_BROWSE, w!("&Browse Library…\tCtrl+B"));
        let _ = AppendMenuW(file, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(file, MF_STRING, IDM_EXPORT, w!("&Export Library for Upload…"));
        let _ = AppendMenuW(file, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(file, MF_STRING, IDM_EXIT, w!("E&xit"));
        let analysis = CreatePopupMenu().unwrap_or_default();
        let _ = AppendMenuW(analysis, MF_STRING, IDM_CANCEL, w!("&Cancel"));
        let _ = AppendMenuW(analysis, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(analysis, MF_STRING, IDM_SIMILAR, w!("Find &Similar"));
        let _ = AppendMenuW(analysis, MF_STRING, IDM_SUBMIT, w!("Su&bmit Build…"));
        let view = CreatePopupMenu().unwrap_or_default();
        let _ = AppendMenuW(view, MF_STRING, IDM_VIEW_OVERVIEW, w!("&Overview"));
        let _ = AppendMenuW(view, MF_STRING, IDM_VIEW_ASSETS, w!("&Assets"));
        let _ = AppendMenuW(view, MF_STRING, IDM_VIEW_XML, w!("&DAT (XML)"));
        let _ = AppendMenuW(view, MF_STRING, IDM_VIEW_JSON, w!("&JSON"));
        let _ = AppendMenuW(menu, MF_POPUP, file.0 as usize, w!("&File"));
        let _ = AppendMenuW(menu, MF_POPUP, view.0 as usize, w!("&View"));
        let _ = AppendMenuW(menu, MF_POPUP, analysis.0 as usize, w!("&Analysis"));
        let _ = SetMenu(hwnd, menu);
        recent
    }

    unsafe fn layout(hwnd: HWND, st: &AppState) {
        let mut rc = windows::Win32::Foundation::RECT::default();
        if GetClientRect(hwnd, &mut rc).is_err() {
            return;
        }
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;
        let content_h = (h - STATUS_H - PROGRESS_H).max(0);
        let tree_w = (w as f32 * 0.38) as i32;

        let pane_w = (w - tree_w).max(0);
        let _ = MoveWindow(st.tree, 0, 0, tree_w, content_h, true);
        let _ = MoveWindow(st.edit, tree_w, 0, pane_w, content_h, true);
        let _ = MoveWindow(st.list, tree_w, 0, pane_w, content_h, true);
        // Field column fixed; value column fills the rest (less the key column + scrollbar).
        let key_w = 150;
        let _ = SendMessageW(st.list, LVM_SETCOLUMNWIDTH, WPARAM(0), LPARAM(key_w as isize));
        let _ = SendMessageW(
            st.list,
            LVM_SETCOLUMNWIDTH,
            WPARAM(1),
            LPARAM((pane_w - key_w - 24).max(80) as isize),
        );
        let _ = MoveWindow(st.progress, 0, content_h, w, PROGRESS_H, true);
        let _ = MoveWindow(st.status, 0, content_h + PROGRESS_H, w, STATUS_H, true);

        // Library mode overlays the same content area: search + filter on top, list below.
        let (pad, top_h, combo_w) = (6, 22, 200);
        let _ = MoveWindow(st.lib_search, pad, pad, (w - combo_w - pad * 3).max(80), top_h, true);
        let _ = MoveWindow(st.lib_combo, w - combo_w - pad, pad, combo_w, 240, true);
        let list_y = pad + top_h + pad;
        let _ = MoveWindow(st.lib_list, pad, list_y, (w - pad * 2).max(0), (content_h - list_y - pad).max(0), true);
    }

    unsafe fn on_command(hwnd: HWND, id: usize) {
        match id {
            IDM_OPEN => {
                if let Some(path) = pick_file(hwnd) {
                    start_analysis(hwnd, path);
                }
            }
            IDM_REANALYZE => {
                // Full re-parse and re-hash, replacing the library record — for
                // dumps whose earlier parse is known bad (plain re-analyze is a
                // cache hit that only tops up assets).
                if let Some(path) = pick_file(hwnd) {
                    start_analysis_with(hwnd, path, true);
                }
            }
            IDM_OPEN_DIR_BUILD => {
                // Force the whole folder through as ONE build (a split multi-track
                // dump), regardless of the single-build heuristic.
                if let Some(dir) = pick_folder(hwnd) {
                    start_analysis(hwnd, dir);
                }
            }
            IDM_OPEN_FOLDER => {
                if let Some(dir) = pick_folder(hwnd) {
                    let units = expand_inputs(vec![dir]);
                    // A folder that is itself one split build analyzes as one unit.
                    match units.len() {
                        0 => set_status(hwnd, "Nothing to import."),
                        1 => start_analysis(hwnd, units.into_iter().next().unwrap()),
                        _ => start_import(hwnd, units),
                    }
                }
            }
            IDM_CANCEL => {
                if let Some(st) = state(hwnd) {
                    st.cancel.store(true, Ordering::SeqCst);
                    set_status(hwnd, "Cancelling…");
                }
            }
            IDM_EXPORT => export_library(hwnd),
            IDM_BROWSE => show_library(hwnd),
            IDM_SIMILAR => find_similar(hwnd),
            IDM_SUBMIT => submit_build(hwnd),
            IDM_VIEW_OVERVIEW => set_view(hwnd, DocView::Overview),
            IDM_VIEW_ASSETS => set_view(hwnd, DocView::Assets),
            IDM_VIEW_XML => set_view(hwnd, DocView::Xml),
            IDM_VIEW_JSON => set_view(hwnd, DocView::Json),
            IDM_EXIT => {
                let _ = DestroyWindow(hwnd);
            }
            other if other >= IDM_RECENT_BASE && other < IDM_RECENT_BASE + MAX_RECENT as usize => {
                open_recent(hwnd, other - IDM_RECENT_BASE);
            }
            _ => {}
        }
    }

    unsafe fn pick_file(hwnd: HWND) -> Option<String> {
        let mut buf = [0u16; 1024];
        let mut ofn = OPENFILENAMEW {
            lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
            hwndOwner: hwnd,
            lpstrFile: PWSTR(buf.as_mut_ptr()),
            nMaxFile: buf.len() as u32,
            lpstrFilter: w!("Disc images & containers\0*.bin;*.iso;*.cue;*.img;*.chd;*.zip;*.7z;*.rar\0All files\0*.*\0"),
            Flags: OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST,
            ..Default::default()
        };
        if GetOpenFileNameW(&mut ofn).as_bool() {
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..end]))
        } else {
            None
        }
    }

    /// IFileDialog in folder mode: the regular Explorer Open dialog, which (unlike
    /// SHBrowseForFolder) remembers the last-visited location across invocations.
    unsafe fn pick_folder(hwnd: HWND) -> Option<String> {
        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
        let opts = dialog.GetOptions().ok()?;
        let _ = dialog.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
        let _ = dialog.SetTitle(w!("Select a folder to analyze"));
        dialog.Show(hwnd).ok()?; // Err == cancelled
        let item = dialog.GetResult().ok()?;
        let pw = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let path = pw.to_string().ok();
        CoTaskMemFree(Some(pw.0 as *const core::ffi::c_void));
        path
    }

    /// Save-As dialog for the export bundle. Defaults to `collection.prism.zip`
    /// and appends `.zip` if the user omits an extension.
    unsafe fn pick_save_file(hwnd: HWND) -> Option<String> {
        let mut buf = [0u16; 1024];
        for (i, c) in "collection.prism.zip".encode_utf16().enumerate() {
            buf[i] = c;
        }
        let mut ofn = OPENFILENAMEW {
            lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
            hwndOwner: hwnd,
            lpstrFile: PWSTR(buf.as_mut_ptr()),
            nMaxFile: buf.len() as u32,
            lpstrFilter: w!("Prism bundle (*.zip)\0*.zip\0All files\0*.*\0"),
            lpstrDefExt: w!("zip"),
            Flags: OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST,
            ..Default::default()
        };
        if GetSaveFileNameW(&mut ofn).as_bool() {
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..end]))
        } else {
            None
        }
    }

    unsafe fn start_analysis(hwnd: HWND, path: String) {
        start_analysis_with(hwnd, path, false);
    }

    unsafe fn start_analysis_with(hwnd: HWND, path: String, force: bool) {
        let Some(st) = state(hwnd) else { return };
        if st.working {
            return;
        }
        st.working = true;
        st.cancel.store(false, Ordering::SeqCst);
        st.totals.clear();
        st.events.lock().unwrap().clear();
        let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM(0), LPARAM(0));
        set_status(hwnd, &format!("Analyzing {path}…"));

        let events = st.events.clone();
        let cancel = st.cancel.clone();
        let analyzer = st.analyzer.clone();
        let adapter = st.adapter.clone();
        let data_dir = st.data_dir.clone();
        let hwnd_i = hwnd.0 as isize;

        std::thread::spawn(move || {
            let outcome: std::result::Result<AnalysisDone, String> = (|| {
                let mut guard = analyzer.lock().unwrap();
                if guard.is_none() {
                    *guard = Some(
                        Analyzer::new(Config { adapter, data_dir }).map_err(|e| e.to_string())?,
                    );
                }
                let obs: Arc<dyn ProgressObserver> =
                    Arc::new(WinObserver { hwnd: hwnd_i, events, cancel });
                let analyzer = guard.as_ref().unwrap();
                let analysis = if force {
                    analyzer.reanalyze(&path, obs)
                } else {
                    analyzer.analyze(&path, obs)
                }
                .map_err(|e| e.to_string())?;
                let xml = render::to_dat_xml(&analysis.record);
                let json = render::to_json(&analysis.record).map_err(|e| e.to_string())?;
                Ok(AnalysisDone { record: analysis.record, xml, json, from_cache: analysis.from_cache })
            })();

            let ptr = Box::into_raw(Box::new(outcome));
            // SAFETY: `ptr` is a live `Box<Result<AnalysisDone, String>>` matching what the
            // WM_APP_DONE handler (`on_done`) reclaims. If the target window is already gone
            // PostMessageW fails and would otherwise leak the heap payload, so we take it back.
            if PostMessageW(
                HWND(hwnd_i as *mut core::ffi::c_void),
                WM_APP_DONE,
                WPARAM(0),
                LPARAM(ptr as isize),
            )
            .is_err()
            {
                drop(Box::from_raw(ptr));
            }
        });
    }

    unsafe fn drain_progress(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        let importing = st.importing;
        let mut queue = st.events.lock().unwrap();
        while let Some(ev) = queue.pop_front() {
            match ev {
                UiEvent::Batch { index, total, name } => {
                    // Show just the file name, not the full path.
                    let file = std::path::Path::new(&name)
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or(name);
                    st.import_base = format!("Importing {} of {}: {}", index + 1, total, file);
                    set_status(hwnd, &st.import_base);
                }
                UiEvent::Open { id, label, total } => {
                    if let Some(t) = total {
                        st.totals.insert(id, t);
                    }
                    let _ = SendMessageW(st.progress, PBM_SETRANGE32, WPARAM(0), LPARAM(1000));
                    // A single analyze shows the per-stage label; an import keeps its
                    // "Importing x of y" line (per-file % is appended on Progress).
                    if !importing {
                        set_status(hwnd, &label);
                    }
                }
                UiEvent::Progress { id, count } => {
                    if let Some(t) = st.totals.get(&id).copied() {
                        if t > 0.0 {
                            let frac = (count / t).clamp(0.0, 1.0);
                            let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM((frac * 1000.0) as usize), LPARAM(0));
                            // Show within-file progress in the status line during import.
                            if importing {
                                set_status(hwnd, &format!("{} — {}%", st.import_base, (frac * 100.0) as u32));
                            }
                        }
                    }
                }
                UiEvent::Close { id } => {
                    st.totals.remove(&id);
                    let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM(0), LPARAM(0));
                    if importing {
                        set_status(hwnd, &st.import_base);
                    }
                }
                UiEvent::Message(text) => {
                    if !importing {
                        set_status(hwnd, &text);
                    }
                }
            }
        }
    }

    unsafe fn on_done(hwnd: HWND, lparam: LPARAM) {
        let ptr = lparam.0 as *mut std::result::Result<AnalysisDone, String>;
        if ptr.is_null() {
            return;
        }
        let outcome = *Box::from_raw(ptr);
        if let Some(st) = state(hwnd) {
            st.working = false;
            let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM(0), LPARAM(0));
        }
        match outcome {
            Ok(done) => {
                display_build(hwnd, done);
                refresh_recent(hwnd);
            }
            Err(msg) => {
                set_status(hwnd, "Failed.");
                error_box(hwnd, &msg);
            }
        }
    }

    /// Render a (freshly analyzed or cache-loaded) build into the tree + document pane.
    /// The pane opens on the formatted Overview; the DAT/XML and JSON are available under
    /// the View menu, and clicking a tree node shows that file's metadata.
    unsafe fn display_build(hwnd: HWND, done: AnalysisDone) {
        let tag = if done.from_cache { "cached" } else { "analyzed" };
        let msg = format!(
            "[{tag}] {} — {}, {} files",
            done.record.image.sha256, done.record.info.system, done.record.structural.file_count
        );
        if let Some(st) = state(hwnd) {
            st.node_sections = populate_tree(st.tree, &done.record);
            st.last_json = Some(done.json.clone());
            st.last_sha = Some(done.record.image.sha256.clone());
            st.assets = done.record.assets.clone().unwrap_or_default();
            st.assets_extracted = done.record.assets.is_some();
            st.asset_rows = Vec::new();
            st.doc_xml = done.xml.replace('\n', "\r\n");
            st.doc_overview = summary::overview_sections(&done.record);
            st.selected_sections = Vec::new();
            st.view = DocView::Overview;
            st.library_mode = false; // opening a build leaves library mode
        }
        apply_mode(hwnd);
        set_status(hwnd, &msg);
    }

    /// Switch the main pane between build view (tree + document) and library view
    /// (search + sortable list), then re-lay-out. Library reads use a separate DB
    /// connection, so this stays usable while an import runs.
    unsafe fn apply_mode(hwnd: HWND) {
        let lib = state(hwnd).map(|st| st.library_mode).unwrap_or(false);
        if let Some(st) = state(hwnd) {
            let _ = ShowWindow(st.tree, if lib { SW_HIDE } else { SW_SHOW });
            let _ = ShowWindow(st.lib_search, if lib { SW_SHOW } else { SW_HIDE });
            let _ = ShowWindow(st.lib_combo, if lib { SW_SHOW } else { SW_HIDE });
            let _ = ShowWindow(st.lib_list, if lib { SW_SHOW } else { SW_HIDE });
            if lib {
                let _ = ShowWindow(st.edit, SW_HIDE);
                let _ = ShowWindow(st.list, SW_HIDE);
            }
        }
        if !lib {
            apply_view(hwnd); // restores edit/list per the active document view
        }
        if let Some(st) = state(hwnd) {
            layout(hwnd, st);
        }
    }

    /// Show the control for the active view (ListView for Overview/Selection/Assets,
    /// EDIT for Xml/Json) and load its content.
    unsafe fn apply_view(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        let grouped = matches!(st.view, DocView::Overview | DocView::Selection | DocView::Assets);
        let _ = ShowWindow(st.list, if grouped { SW_SHOW } else { SW_HIDE });
        let _ = ShowWindow(st.edit, if grouped { SW_HIDE } else { SW_SHOW });
        match st.view {
            DocView::Overview => fill_list(st.list, &st.doc_overview),
            DocView::Selection => fill_list(st.list, &st.selected_sections),
            DocView::Assets => fill_assets(st),
            DocView::Xml | DocView::Json => {
                let text = if matches!(st.view, DocView::Xml) {
                    st.doc_xml.clone()
                } else {
                    st.last_json.clone().unwrap_or_default()
                };
                let w = wide(&text);
                let _ = SetWindowTextW(st.edit, PCWSTR(w.as_ptr()));
            }
        }
    }

    unsafe fn set_view(hwnd: HWND, view: DocView) {
        if matches!(view, DocView::Assets) {
            ensure_reader(hwnd); // fill_assets checks blob presence via the reader
        }
        if let Some(st) = state(hwnd) {
            st.view = view;
        }
        apply_view(hwnd);
        if matches!(view, DocView::Assets) {
            set_status(hwnd, "Double-click an asset to open it.");
        }
    }

    /// Fill the grouped ListView with the loaded build's assets (one group per kind)
    /// and rebuild the row → asset index map used by double-click-to-open.
    unsafe fn fill_assets(st: &mut AppState) {
        let (sections, rows) = summary::asset_sections(&st.assets, st.assets_extracted, &|sha| {
            st.reader.as_ref().and_then(|r| r.asset_blob_path(sha)).is_some()
        });
        st.asset_rows = rows;
        fill_list(st.list, &sections);
    }

    /// Clear and repopulate the grouped ListView from `sections`.
    unsafe fn fill_list(list: HWND, sections: &[Section]) {
        let _ = SendMessageW(list, LVM_DELETEALLITEMS, WPARAM(0), LPARAM(0));
        let _ = SendMessageW(list, LVM_REMOVEALLGROUPS, WPARAM(0), LPARAM(0));
        let mut row_index = 0i32;
        for (gid, sec) in sections.iter().enumerate() {
            let mut htext = wide(&sec.title);
            let mut grp = LVGROUP::default();
            grp.cbSize = std::mem::size_of::<LVGROUP>() as u32;
            grp.mask = LVGF_HEADER | LVGF_GROUPID | LVGF_ALIGN;
            grp.pszHeader = PWSTR(htext.as_mut_ptr());
            grp.cchHeader = sec.title.encode_utf16().count() as i32;
            grp.iGroupId = gid as i32;
            grp.uAlign = LVGA_HEADER_LEFT;
            let _ = SendMessageW(
                list,
                LVM_INSERTGROUP,
                WPARAM(usize::MAX),
                LPARAM(&grp as *const _ as isize),
            );
            for (key, value) in &sec.rows {
                let mut kw = wide(key);
                let mut item = LVITEMW::default();
                item.mask = LVIF_TEXT | LVIF_GROUPID;
                item.iItem = row_index;
                item.iSubItem = 0;
                item.pszText = PWSTR(kw.as_mut_ptr());
                item.iGroupId = gid as i32;
                let inserted =
                    SendMessageW(list, LVM_INSERTITEMW, WPARAM(0), LPARAM(&item as *const _ as isize)).0
                        as i32;
                let mut vw = wide(value);
                let mut sub = LVITEMW::default();
                sub.mask = LVIF_TEXT;
                sub.iItem = inserted;
                sub.iSubItem = 1;
                sub.pszText = PWSTR(vw.as_mut_ptr());
                let _ = SendMessageW(list, LVM_SETITEMW, WPARAM(0), LPARAM(&sub as *const _ as isize));
                row_index = inserted + 1;
            }
        }
    }

    /// Notifications from child controls: tree selection → show that node's metadata;
    /// double-click a ListView row → copy its value to the clipboard.
    unsafe fn on_notify(hwnd: HWND, lparam: LPARAM) {
        let nmhdr = &*(lparam.0 as *const NMHDR);
        let (from, code) = (nmhdr.hwndFrom, nmhdr.code);
        let mut selection_changed = false;
        let mut copied: Option<String> = None;
        let mut open_sha: Option<String> = None;
        let mut open_asset: Option<usize> = None;
        let mut lib_resort = false;
        if let Some(st) = state(hwnd) {
            if from == st.tree && code == TVN_SELCHANGEDW {
                let tv = &*(lparam.0 as *const NMTREEVIEWW);
                let idx = tv.itemNew.lParam.0 as usize;
                if let Some(sec) = st.node_sections.get(idx) {
                    st.selected_sections = vec![sec.clone()];
                    st.view = DocView::Selection;
                    selection_changed = true;
                }
            } else if from == st.list && code == NM_DBLCLK as u32 {
                let nia = &*(lparam.0 as *const NMITEMACTIVATE);
                if nia.iItem >= 0 {
                    // In the assets view a row is a file to open; elsewhere it's
                    // a key/value pair whose value copies to the clipboard.
                    if st.view == DocView::Assets {
                        open_asset = st.asset_rows.get(nia.iItem as usize).copied();
                    } else {
                        copied = Some(list_value(st.list, nia.iItem));
                    }
                }
            } else if from == st.lib_list && code == NM_DBLCLK as u32 {
                let nia = &*(lparam.0 as *const NMITEMACTIVATE);
                if nia.iItem >= 0 {
                    open_sha = st.lib_rows.get(nia.iItem as usize).cloned();
                }
            } else if from == st.lib_list && code == LVN_COLUMNCLICK as u32 {
                let nlv = &*(lparam.0 as *const NMLISTVIEW);
                let col = match nlv.iSubItem {
                    0 => LibrarySort::Name,
                    1 => LibrarySort::System,
                    2 => LibrarySort::Files,
                    3 => LibrarySort::Size,
                    _ => LibrarySort::Date,
                };
                if st.lib_sort == col {
                    st.lib_desc = !st.lib_desc;
                } else {
                    st.lib_sort = col;
                    st.lib_desc = !matches!(col, LibrarySort::Name | LibrarySort::System);
                }
                lib_resort = true;
            }
        }
        if selection_changed {
            apply_view(hwnd);
        }
        if lib_resort {
            refresh_library(hwnd);
        }
        if let Some(sha) = open_sha {
            open_sha256(hwnd, &sha); // leaves library mode and shows the build
        }
        if let Some(idx) = open_asset {
            open_asset_at(hwnd, idx);
        }
        if let Some(value) = copied {
            if !value.is_empty() {
                copy_to_clipboard(hwnd, &value);
                set_status(hwnd, "Copied value to clipboard.");
            }
        }
    }

    /// Read a ListView row's value column (subitem 1).
    unsafe fn list_value(list: HWND, row: i32) -> String {
        let mut buf = [0u16; 2048];
        let mut item = LVITEMW::default();
        item.iSubItem = 1;
        item.pszText = PWSTR(buf.as_mut_ptr());
        item.cchTextMax = buf.len() as i32;
        let n = SendMessageW(list, LVM_GETITEMTEXTW, WPARAM(row as usize), LPARAM(&mut item as *mut _ as isize)).0;
        String::from_utf16_lossy(&buf[..(n as usize).min(buf.len())])
    }

    unsafe fn copy_to_clipboard(hwnd: HWND, text: &str) {
        let wtext: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        if OpenClipboard(hwnd).is_err() {
            return;
        }
        let _ = EmptyClipboard();
        if let Ok(hmem) = GlobalAlloc(GMEM_MOVEABLE, wtext.len() * 2) {
            let p = GlobalLock(hmem);
            if !p.is_null() {
                std::ptr::copy_nonoverlapping(wtext.as_ptr(), p as *mut u16, wtext.len());
                let _ = GlobalUnlock(hmem);
                // CF_UNICODETEXT = 13. On success the clipboard owns the memory.
                if SetClipboardData(13u32, HANDLE(hmem.0)).is_err() {
                    let _ = GlobalUnlock(hmem); // best-effort; free not exposed here
                }
            }
        }
        let _ = CloseClipboard();
    }

    /// Build the analyzer (library + cache) on demand. Returns false if it can't open.
    unsafe fn ensure_analyzer(st: &AppState) -> bool {
        let mut g = st.analyzer.lock().unwrap();
        if g.is_none() {
            match Analyzer::new(Config { adapter: st.adapter.clone(), data_dir: st.data_dir.clone() }) {
                Ok(a) => *g = Some(a),
                Err(_) => return false,
            }
        }
        true
    }

    /// Repopulate the File ▸ Open Recent submenu from the local library.
    unsafe fn refresh_recent(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        if !ensure_analyzer(st) {
            return;
        }
        let rows = st
            .analyzer
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| a.recent_builds(MAX_RECENT).unwrap_or_default())
            .unwrap_or_default();

        while DeleteMenu(st.recent_menu, 0, MF_BYPOSITION).is_ok() {}
        st.recent.clear();
        if rows.is_empty() {
            let _ = AppendMenuW(st.recent_menu, MF_STRING | MF_GRAYED, 0, w!("(none yet)"));
            return;
        }
        for (i, r) in rows.iter().enumerate() {
            let label = wide(&format!("{}  —  {}", r.name, r.system));
            let _ = AppendMenuW(st.recent_menu, MF_STRING, IDM_RECENT_BASE + i, PCWSTR(label.as_ptr()));
            st.recent.push(r.sha256.clone());
        }
    }

    /// Reopen a stored build from cache (no re-analysis).
    unsafe fn open_recent(hwnd: HWND, idx: usize) {
        let sha = {
            let Some(st) = state(hwnd) else { return };
            st.recent.get(idx).cloned()
        };
        if let Some(sha) = sha {
            open_sha256(hwnd, &sha);
        }
    }

    /// Load a stored build from cache by sha256 and display it (no re-analysis).
    /// Shared by the Recent menu and the library browser.
    unsafe fn open_sha256(hwnd: HWND, sha: &str) {
        // Load via the reader (own connection + cache), not the analyzer — so this works
        // mid-import without bailing on `working` or blocking on the import's writer lock.
        ensure_reader(hwnd);
        // A single `&mut AppState`, scoped so it is dropped before `display_build` (which
        // re-derives its own &mut); holding two simultaneously would be aliasing UB.
        let loaded = {
            let Some(st) = state(hwnd) else { return };
            st.reader.as_ref().and_then(|r| r.load_cached(sha).ok().flatten())
        };
        match loaded {
            Some(analysis) => {
                let xml = render::to_dat_xml(&analysis.record);
                match render::to_json(&analysis.record) {
                    Ok(json) => {
                        display_build(hwnd, AnalysisDone { record: analysis.record, xml, json, from_cache: true });
                    }
                    Err(e) => set_status(hwnd, &format!("Failed to render record: {e}")),
                }
            }
            None => set_status(hwnd, "Build not in cache anymore."),
        }
    }

    /// WM_DROPFILES: analyze a single dropped file (or a folder that is one split
    /// multi-track build), or batch-import when the drop expands to several units.
    unsafe fn on_drop(hwnd: HWND, wparam: WPARAM) {
        let hdrop = HDROP(wparam.0 as *mut core::ffi::c_void);
        let count = DragQueryFileW(hdrop, u32::MAX, None);
        let mut paths = Vec::new();
        for i in 0..count {
            let mut buf = [0u16; 1024];
            let n = DragQueryFileW(hdrop, i, Some(&mut buf));
            if n > 0 {
                paths.push(String::from_utf16_lossy(&buf[..n as usize]));
            }
        }
        DragFinish(hdrop);

        let files = expand_inputs(paths);
        match files.len() {
            0 => set_status(hwnd, "Nothing to import."),
            1 => start_analysis(hwnd, files.into_iter().next().unwrap()),
            _ => start_import(hwnd, files),
        }
    }

    /// Expand dropped/selected paths to a flat list of import units: directories
    /// are walked recursively, except that a folder holding one build split across
    /// files (a multi-track dump) stays a single unit and analyzes as one build.
    /// Plain files pass through. Order is deterministic.
    fn expand_inputs(paths: Vec<String>) -> Vec<String> {
        let mut out = Vec::new();
        for p in paths {
            let path = std::path::Path::new(&p);
            if path.is_dir() {
                for f in prism_core::list_import_units(path) {
                    out.push(f.to_string_lossy().into_owned());
                }
            } else if path.is_file() {
                out.push(p);
            }
        }
        out
    }

    /// Batch-import a flat list of files: analyze each, skipping any that don't parse.
    /// Runs on a worker thread with per-item batch progress and cooperative cancel.
    unsafe fn start_import(hwnd: HWND, files: Vec<String>) {
        let Some(st) = state(hwnd) else { return };
        if st.working {
            return;
        }
        if files.is_empty() {
            set_status(hwnd, "No files found to import.");
            return;
        }
        st.working = true;
        st.importing = true;
        st.cancel.store(false, Ordering::SeqCst);
        st.totals.clear();
        st.events.lock().unwrap().clear();
        let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM(0), LPARAM(0));
        set_status(hwnd, &format!("Importing {} files…", files.len()));

        let events = st.events.clone();
        let cancel = st.cancel.clone();
        let analyzer = st.analyzer.clone();
        let adapter = st.adapter.clone();
        let data_dir = st.data_dir.clone();
        let hwnd_i = hwnd.0 as isize;

        std::thread::spawn(move || {
            let total = files.len() as u64;
            // Create the analyzer once, then release the lock so it isn't held across
            // the whole batch.
            {
                let mut guard = analyzer.lock().unwrap();
                if guard.is_none() {
                    match Analyzer::new(Config { adapter, data_dir }) {
                        Ok(a) => *guard = Some(a),
                        Err(e) => {
                            post_import_done(hwnd_i, format!("Import failed: {e}"));
                            return;
                        }
                    }
                }
            }
            let (mut imported, mut skipped, mut cancelled) = (0u64, 0u64, false);
            for (i, path) in files.iter().enumerate() {
                if cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                    break;
                }
                // "Importing i/N: name" status line; the per-file hashing bar follows.
                events
                    .lock()
                    .unwrap()
                    .push_back(UiEvent::Batch { index: i as u64, total, name: path.clone() });
                let _ = PostMessageW(
                    HWND(hwnd_i as *mut core::ffi::c_void),
                    WM_APP_PROGRESS,
                    WPARAM(0),
                    LPARAM(0),
                );
                let obs: Arc<dyn ProgressObserver> =
                    Arc::new(WinObserver { hwnd: hwnd_i, events: events.clone(), cancel: cancel.clone() });
                // Lock only for this one analysis, so library reads (separate connection)
                // and the message pump aren't blocked for the whole batch. Each analyze
                // persists its build before returning, so progress is saved per item.
                let result = {
                    let guard = analyzer.lock().unwrap();
                    match guard.as_ref() {
                        Some(a) => a.analyze(path, obs),
                        None => continue,
                    }
                };
                match result {
                    Ok(_) => {
                        imported += 1;
                        // Reflect the just-saved item in library mode, live.
                        let _ = PostMessageW(
                            HWND(hwnd_i as *mut core::ffi::c_void),
                            WM_APP_LIB_REFRESH,
                            WPARAM(0),
                            LPARAM(0),
                        );
                    }
                    Err(prism_core::Error::Cancelled) => {
                        cancelled = true;
                        break;
                    }
                    Err(_) => skipped += 1, // unsupported/unreadable — skip and continue
                }
            }
            let summary = if cancelled {
                format!("Import cancelled — {imported} imported, {skipped} skipped.")
            } else {
                format!("Imported {imported}, skipped {skipped} unsupported.")
            };
            post_import_done(hwnd_i, summary);
        });
    }

    fn post_import_done(hwnd_i: isize, summary: String) {
        let ptr = Box::into_raw(Box::new(summary));
        // SAFETY: matches the `Box<String>` `on_import_done` reclaims; if the window
        // is gone the post fails and we take the allocation back to avoid a leak.
        unsafe {
            if PostMessageW(
                HWND(hwnd_i as *mut core::ffi::c_void),
                WM_APP_IMPORT_DONE,
                WPARAM(0),
                LPARAM(ptr as isize),
            )
            .is_err()
            {
                drop(Box::from_raw(ptr));
            }
        }
    }

    unsafe fn on_import_done(hwnd: HWND, lparam: LPARAM) {
        let ptr = lparam.0 as *mut String;
        if ptr.is_null() {
            return;
        }
        let summary = *Box::from_raw(ptr);
        if let Some(st) = state(hwnd) {
            st.working = false;
            st.importing = false;
            let _ = SendMessageW(st.progress, PBM_SETPOS, WPARAM(0), LPARAM(0));
        }
        set_status(hwnd, &summary);
        refresh_recent(hwnd);
    }

    /// Subclass proc on the panes: forward dropped files to the main window.
    unsafe extern "system" fn drop_subclass(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_DROPFILES {
            if let Ok(parent) = GetParent(hwnd) {
                on_drop(parent, wparam);
            }
            return LRESULT(0);
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /// Fill the tree and return per-node metadata sections, indexed by each item's lParam.
    unsafe fn populate_tree(tree: HWND, record: &BuildRecord) -> Vec<Section> {
        let _ = SendMessageW(tree, TVM_DELETEITEM, WPARAM(0), LPARAM(TVI_ROOT.0));
        let mut sections = Vec::new();
        for node in &record.contents {
            insert_node(tree, TVI_ROOT, node, &mut sections);
        }
        sections
    }

    unsafe fn insert_node(
        tree: HWND,
        parent: windows::Win32::UI::Controls::HTREEITEM,
        node: &Node,
        sections: &mut Vec<Section>,
    ) {
        let idx = sections.len();
        sections.push(summary::node_section(node));
        let mut label = wide(node.name());
        let mut item = TVITEMW::default();
        item.mask = TVIF_TEXT | TVIF_PARAM;
        item.pszText = PWSTR(label.as_mut_ptr());
        item.lParam = LPARAM(idx as isize);
        let ins = TVINSERTSTRUCTW {
            hParent: parent,
            hInsertAfter: TVI_LAST,
            Anonymous: TVINSERTSTRUCTW_0 { item },
        };
        let lr = SendMessageW(tree, TVM_INSERTITEMW, WPARAM(0), LPARAM(&ins as *const _ as isize));
        let handle = windows::Win32::UI::Controls::HTREEITEM(lr.0);
        if let Node::Dir { children, .. } = node {
            for child in children {
                insert_node(tree, handle, child, sections);
            }
        }
    }

    // ---- modal error dialog (selectable, copyable) ----

    struct ErrorState {
        /// CRLF-normalized, NUL-terminated message for the read-only edit control.
        text: Vec<u16>,
        edit: HWND,
        done: bool,
    }

    const IDC_ERR_COPY: usize = 110;
    const IDC_ERR_CLOSE: usize = 111;
    const EM_SETSEL_MSG: u32 = 0x00B1;
    const WM_COPY_MSG: u32 = 0x0301;

    /// Show a dismissable modal error dialog (in addition to the status-bar note).
    /// Adapter failures are often long multi-line tracebacks; a read-only multiline
    /// edit control lets the user select and copy the text (Ctrl+C or "Copy all"),
    /// which a plain MessageBox does not.
    unsafe fn error_box(owner: HWND, text: &str) {
        let Ok(hinstance) = GetModuleHandleW(None) else { return };
        let class = w!("PrismError");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(error_proc),
            hInstance: hinstance.into(),
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hIcon: LoadIconW(hinstance, APP_ICON_ID).unwrap_or_default(),
            hbrBackground: HBRUSH(6 as *mut core::ffi::c_void),
            ..Default::default()
        };
        RegisterClassW(&wc); // idempotent enough for a one-window app

        let mut es = ErrorState {
            text: wide(&text.replace("\r\n", "\n").replace('\n', "\r\n")),
            edit: HWND::default(),
            done: false,
        };
        let Ok(dlg) = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("Prism — Analysis failed"),
            WS_POPUPWINDOW | WS_CAPTION | WS_THICKFRAME | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            560,
            380,
            owner,
            None,
            hinstance,
            Some(&mut es as *mut ErrorState as *const core::ffi::c_void),
        ) else {
            return;
        };

        let _ = EnableWindow(owner, false);
        let mut msg = MSG::default();
        while !es.done && GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if !IsDialogMessageW(dlg, &msg).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        let _ = EnableWindow(owner, true);
        let _ = SetForegroundWindow(owner);
        let _ = DestroyWindow(dlg);
    }

    extern "system" fn error_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_CREATE => {
                    let cs = lparam.0 as *const CREATESTRUCTW;
                    let es = (*cs).lpCreateParams as *mut ErrorState;
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, es as isize);
                    let hinst = (*cs).hInstance;
                    let edit_style = WS_CHILD
                        | WS_VISIBLE
                        | WS_BORDER
                        | WS_VSCROLL
                        | WINDOW_STYLE((ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL) as u32);
                    let edit = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("EDIT"),
                        PCWSTR::null(),
                        edit_style,
                        0, 0, 0, 0, hwnd, None, hinst, None,
                    )
                    .unwrap_or_default();
                    let _ = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("Copy all"),
                        WS_CHILD | WS_VISIBLE,
                        0, 0, 0, 0, hwnd,
                        HMENU(IDC_ERR_COPY as *mut core::ffi::c_void), hinst, None,
                    );
                    let _ = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("Close"),
                        WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_DEFPUSHBUTTON as u32),
                        0, 0, 0, 0, hwnd,
                        HMENU(IDC_ERR_CLOSE as *mut core::ffi::c_void), hinst, None,
                    );
                    let font = GetStockObject(DEFAULT_GUI_FONT);
                    for child in child_windows(hwnd) {
                        let _ = SendMessageW(child, WM_SETFONT, WPARAM(font.0 as usize), LPARAM(1));
                    }
                    if let Some(es) = es.as_mut() {
                        es.edit = edit;
                        let _ = SetWindowTextW(edit, PCWSTR(es.text.as_ptr()));
                    }
                    LRESULT(0)
                }
                WM_SIZE => {
                    if let Some(es) = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ErrorState).as_ref() {
                        let w = (lparam.0 & 0xffff) as i32;
                        let h = ((lparam.0 >> 16) & 0xffff) as i32;
                        let (pad, btn_w, btn_h) = (10, 90, 26);
                        let edit_h = (h - btn_h - 3 * pad).max(0);
                        let _ = MoveWindow(es.edit, pad, pad, (w - 2 * pad).max(0), edit_h, true);
                        let btn_y = h - btn_h - pad;
                        let _ = MoveWindow(
                            GetDlgItem(hwnd, IDC_ERR_CLOSE as i32).unwrap_or_default(),
                            w - btn_w - pad, btn_y, btn_w, btn_h, true,
                        );
                        let _ = MoveWindow(
                            GetDlgItem(hwnd, IDC_ERR_COPY as i32).unwrap_or_default(),
                            w - 2 * btn_w - 2 * pad, btn_y, btn_w, btn_h, true,
                        );
                    }
                    LRESULT(0)
                }
                WM_COMMAND => {
                    let id = (wparam.0 & 0xffff) as usize;
                    let es = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ErrorState;
                    if let Some(es) = es.as_mut() {
                        match id {
                            IDC_ERR_COPY => {
                                // Select all, then copy the selection to the clipboard.
                                let _ = SendMessageW(es.edit, EM_SETSEL_MSG, WPARAM(0), LPARAM(-1));
                                let _ = SendMessageW(es.edit, WM_COPY_MSG, WPARAM(0), LPARAM(0));
                            }
                            // IDC_ERR_CLOSE, or IDOK/IDCANCEL synthesized by Enter/Esc.
                            IDC_ERR_CLOSE | 1 | 2 => es.done = true,
                            _ => {}
                        }
                    }
                    LRESULT(0)
                }
                WM_CLOSE => {
                    if let Some(es) = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ErrorState).as_mut() {
                        es.done = true;
                    }
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

    /// Collect a window's immediate child controls (used to apply the shared GUI font).
    unsafe fn child_windows(parent: HWND) -> Vec<HWND> {
        let mut out = Vec::new();
        let mut child = GetWindow(parent, GW_CHILD).unwrap_or_default();
        while !child.0.is_null() {
            out.push(child);
            child = GetWindow(child, GW_HWNDNEXT).unwrap_or_default();
        }
        out
    }

    unsafe fn set_status(hwnd: HWND, text: &str) {
        if let Some(st) = state(hwnd) {
            let wtext = wide(text);
            let _ = SendMessageW(
                st.status,
                windows::Win32::UI::Controls::SB_SETTEXTW,
                WPARAM(0),
                LPARAM(wtext.as_ptr() as isize),
            );
        }
    }

    // ---- asset viewer ----

    /// Open the asset at `assets[idx]`. Media and document kinds go to their
    /// default app via a temp copy carrying the original filename (store blobs
    /// are extensionless, so the shell can't pick a handler for them directly)
    /// — PDFs land in the default PDF viewer; TGA images are staged as BMP
    /// because stock Windows has no TGA handler. Text and source kinds
    /// always open in Notepad: handing a `.bat`/`.cmd`/`.js` from an untrusted
    /// disc to the shell's default verb would execute it. Binary kinds
    /// (unidentified files' head snippets) open in Notepad as a hex dump.
    unsafe fn open_asset_at(hwnd: HWND, idx: usize) {
        ensure_reader(hwnd);
        let (asset, blob) = {
            let Some(st) = state(hwnd) else { return };
            let Some(asset) = st.assets.get(idx).cloned() else { return };
            let blob = st.reader.as_ref().and_then(|r| r.asset_blob_path(&asset.sha256));
            (asset, blob)
        };
        let Some(blob) = blob else {
            set_status(hwnd, "Asset not in the local store — re-analyze the image to extract it.");
            return;
        };
        let staged = if asset.kind == "binary" {
            materialize_hexdump(&asset, &blob)
        } else if asset.mime == "image/x-tga" {
            materialize_tga(&asset, &blob)
        } else {
            materialize_asset(&asset, &blob)
        };
        let path = match staged {
            Ok(p) => p,
            Err(e) => {
                set_status(hwnd, &format!("Couldn't stage asset: {e}"));
                return;
            }
        };
        let path_str = path.to_string_lossy().into_owned();
        let launched = if matches!(asset.kind.as_str(), "text" | "source" | "binary") {
            let args = wide(&format!("\"{path_str}\""));
            ShellExecuteW(hwnd, w!("open"), w!("notepad.exe"), PCWSTR(args.as_ptr()), PCWSTR::null(), SW_SHOWNORMAL)
        } else {
            let file = wide(&path_str);
            ShellExecuteW(hwnd, w!("open"), PCWSTR(file.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL)
        };
        // ShellExecuteW reports success as a value > 32.
        if launched.0 as isize <= 32 {
            set_status(hwnd, &format!("No application could open {}.", asset.path));
        } else {
            set_status(hwnd, &format!("Opened {}.", asset.path));
        }
    }

    /// The asset's original filename, sanitized for use in a Windows path.
    fn safe_asset_name(asset: &AssetRef) -> String {
        let base = asset.path.rsplit('/').next().unwrap_or_default();
        let safe: String = base
            .chars()
            .map(|c| {
                if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20 {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        if safe.trim_matches(['.', ' ']).is_empty() { asset.sha256.clone() } else { safe }
    }

    /// The asset's per-sha temp dir, created on demand.
    fn asset_temp_dir(asset: &AssetRef) -> std::result::Result<PathBuf, String> {
        let dir = std::env::temp_dir().join("prism-assets").join(&asset.sha256);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    /// Copy a blob into a per-asset temp dir under its original (sanitized)
    /// filename so the shell can pick a handler by extension. Content-addressed,
    /// so an existing copy is reused.
    fn materialize_asset(asset: &AssetRef, blob: &std::path::Path) -> std::result::Result<PathBuf, String> {
        let dest = asset_temp_dir(asset)?.join(safe_asset_name(asset));
        if !dest.exists() {
            std::fs::copy(blob, &dest).map_err(|e| e.to_string())?;
        }
        Ok(dest)
    }

    /// Stage a TGA image as a 32bpp BMP the shell can open — stock Windows has
    /// no TGA handler. An undecodable file is staged raw instead, so users with
    /// a TGA-capable viewer installed can still try it.
    fn materialize_tga(asset: &AssetRef, blob: &std::path::Path) -> std::result::Result<PathBuf, String> {
        let dest = asset_temp_dir(asset)?.join(format!("{}.bmp", safe_asset_name(asset)));
        if dest.exists() {
            return Ok(dest);
        }
        let data = std::fs::read(blob).map_err(|e| e.to_string())?;
        match prism_core::tga::tga_to_bmp(&data) {
            Ok(bmp) => {
                std::fs::write(&dest, bmp).map_err(|e| e.to_string())?;
                Ok(dest)
            }
            Err(_) => materialize_asset(asset, blob),
        }
    }

    /// Render an unidentified file's head-snippet blob as an xxd-style dump in a
    /// temp .txt for Notepad (the raw bytes would be garbage there). Layout
    /// lives here, display-side — the store keeps the raw bytes.
    fn materialize_hexdump(asset: &AssetRef, blob: &std::path::Path) -> std::result::Result<PathBuf, String> {
        let dest = asset_temp_dir(asset)?.join("hexdump.txt");
        if !dest.exists() {
            let data = std::fs::read(blob).map_err(|e| e.to_string())?;
            std::fs::write(&dest, hexdump(&data)).map_err(|e| e.to_string())?;
        }
        Ok(dest)
    }

    /// Classic xxd layout: 8-hex offset, 16 bytes as 2-byte groups, ASCII gutter.
    fn hexdump(data: &[u8]) -> String {
        use std::fmt::Write as _;
        let mut out = String::with_capacity(data.len() * 5);
        for (i, row) in data.chunks(16).enumerate() {
            let _ = write!(out, "{:08x}: ", i * 16);
            for j in 0..16 {
                match row.get(j) {
                    Some(b) => {
                        let _ = write!(out, "{b:02x}");
                    }
                    None => out.push_str("  "),
                }
                if j % 2 == 1 {
                    out.push(' ');
                }
            }
            out.push(' ');
            for &b in row {
                out.push(if (0x20..0x7f).contains(&b) { b as char } else { '.' });
            }
            out.push_str("\r\n");
        }
        out
    }

    // ---- web service: Find Similar / Submit ----

    unsafe fn find_similar(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        let Some(json) = st.last_json.clone() else {
            set_status(hwnd, "Analyze a build first.");
            return;
        };
        let url = format!("{}/api/similarity", st.web_url.trim_end_matches('/'));
        set_status(hwnd, "Querying similar builds…");
        let hwnd_i = hwnd.0 as isize;
        std::thread::spawn(move || {
            let text = match http_post_json(&url, &json) {
                Ok((code, body)) if (200..300).contains(&code) => summary::format_similarity(&body),
                Ok((code, body)) => format!("Server error {code}: {}", body.trim()),
                Err(e) => format!("Cannot reach service: {e}"),
            };
            post_service_result(hwnd_i, text);
        });
    }

    unsafe fn submit_build(hwnd: HWND) {
        let json = {
            let Some(st) = state(hwnd) else { return };
            st.last_json.clone()
        };
        let Some(json) = json else {
            set_status(hwnd, "Analyze a build first.");
            return;
        };
        let Some(nickname) = prompt_nickname(hwnd) else { return };
        if nickname.trim().is_empty() {
            return;
        }
        // Resolve which of the build's asset blobs exist locally (sha256 → path)
        // up front on the UI thread; the worker uploads whichever the server lacks.
        ensure_reader(hwnd);
        let (base, sha, local_assets, token) = {
            let Some(st) = state(hwnd) else { return };
            let mut local: HashMap<String, PathBuf> = HashMap::new();
            for a in &st.assets {
                if let Some(p) = st.reader.as_ref().and_then(|r| r.asset_blob_path(&a.sha256)) {
                    local.insert(a.sha256.clone(), p);
                }
            }
            (
                st.web_url.trim_end_matches('/').to_string(),
                st.last_sha.clone(),
                local,
                st.moderation_token.clone(),
            )
        };
        let url = format!("{base}/api/submissions");
        // { "nickname": <json string>, "record": <record> } — embed the raw record JSON.
        let body = format!(
            "{{\"nickname\":{},\"record\":{}}}",
            serde_json::Value::String(nickname).to_string(),
            json
        );
        set_status(hwnd, "Submitting build…");
        let hwnd_i = hwnd.0 as isize;
        std::thread::spawn(move || {
            let text = match http_post_json(&url, &body) {
                Ok((code, b)) if (200..300).contains(&code) => {
                    let status = serde_json::from_str::<serde_json::Value>(&b)
                        .ok()
                        .and_then(|v| v.get("status").and_then(|s| s.as_str()).map(String::from))
                        .unwrap_or_else(|| "queued".into());
                    let mut note = match &sha {
                        Some(sha) => upload_missing_assets(hwnd_i, &base, sha, &local_assets),
                        None => String::new(),
                    };
                    // With a moderation token, finish the job: accept the submission so
                    // it replaces the live build (assets are uploaded first, above).
                    if let Some(sha) = &sha {
                        if !token.is_empty() {
                            note.push_str(&accept_submission(&base, sha, &token));
                        }
                    }
                    format!("Submitted — {status}.{note}")
                }
                Ok((code, b)) => format!("Server error {code}: {}", b.trim()),
                Err(e) => format!("Cannot reach service: {e}"),
            };
            post_service_result(hwnd_i, text);
        });
    }

    /// Ask the server which of the submitted build's asset blobs it lacks, then
    /// PUT each one we hold locally. Runs on the submit worker thread; interim
    /// one-line progress goes to the status bar. Failures degrade to a note —
    /// the record submission already succeeded.
    unsafe fn upload_missing_assets(
        hwnd_i: isize,
        base: &str,
        build_sha: &str,
        local: &HashMap<String, PathBuf>,
    ) -> String {
        if local.is_empty() {
            return String::new(); // nothing extracted locally — nothing to offer
        }
        let assets_url = format!("{base}/api/submissions/{build_sha}/assets");
        let missing: Vec<String> = match http_request("GET", &assets_url, None, &[]) {
            Ok((code, b)) if (200..300).contains(&code) => serde_json::from_str::<serde_json::Value>(&b)
                .ok()
                .and_then(|v| {
                    v.get("missing").and_then(|m| m.as_array()).map(|arr| {
                        arr.iter().filter_map(|s| s.as_str().map(String::from)).collect()
                    })
                })
                .unwrap_or_default(),
            Ok((code, _)) => return format!(" Asset check failed: server error {code}."),
            Err(e) => return format!(" Asset check failed: {e}."),
        };
        if missing.is_empty() {
            return " Assets already on server.".into();
        }
        let todo: Vec<&String> = missing.iter().filter(|sha| local.contains_key(*sha)).collect();
        let unavailable = missing.len() - todo.len();
        // Upload a few blobs at once — each is its own resumable PUT (chunks of
        // one blob never interleave) and http_request builds a fresh WinHTTP
        // session per call. Workers pull the next index off a shared counter.
        let total = todo.len();
        let next = AtomicUsize::new(0);
        let completed = AtomicUsize::new(0);
        let ok_count = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..PARALLEL_UPLOADS.min(total) {
                s.spawn(|| loop {
                    let Some(sha) = todo.get(next.fetch_add(1, Ordering::Relaxed)) else { break };
                    if upload_asset_chunked(&assets_url, sha, &local[*sha]) {
                        ok_count.fetch_add(1, Ordering::Relaxed);
                    }
                    let n = completed.fetch_add(1, Ordering::Relaxed) + 1;
                    post_service_result(hwnd_i, format!("Uploading assets {n}/{total}…"));
                });
            }
        });
        let uploaded = ok_count.into_inner();
        let failed = total - uploaded;
        let mut note = format!(" Uploaded {uploaded} asset blob{}", if uploaded == 1 { "" } else { "s" });
        if failed > 0 {
            note.push_str(&format!(", {failed} failed"));
        }
        if unavailable > 0 {
            note.push_str(&format!(", {unavailable} not in local store"));
        }
        note.push('.');
        note
    }

    /// Accept the just-submitted build with the moderation token, so the record
    /// (and its refreshed assets) replaces the live build immediately. A failure
    /// degrades to a note — the submission stays queued for manual moderation.
    unsafe fn accept_submission(base: &str, build_sha: &str, token: &str) -> String {
        let url = format!("{base}/api/submissions/{build_sha}");
        let headers = format!("Content-Type: application/json\r\nx-moderation-token: {token}");
        match http_request("POST", &url, Some(&headers), b"{\"action\":\"accept\"}") {
            Ok((code, _)) if (200..300).contains(&code) => " Accepted — live build updated.".into(),
            Ok((401, _)) => " Accept failed: moderation token rejected.".into(),
            Ok((code, b)) => format!(" Accept failed: server error {code}: {}.", b.trim()),
            Err(e) => format!(" Accept failed: {e}."),
        }
    }

    /// Upload chunk size — small enough to clear typical proxy body-size limits.
    const UPLOAD_CHUNK: usize = 4 * 1024 * 1024;

    /// How many asset blobs to upload at once.
    const PARALLEL_UPLOADS: usize = 32;

    /// Give up after this many consecutive rate-limit waits on one chunk.
    const MAX_THROTTLE_RETRIES: u32 = 30;

    /// PUT one asset blob in resumable chunks: each request appends at `offset`,
    /// a 409 answers with the server's staged offset to resume from, and the
    /// final chunk returns `stored` (or `exists`).
    unsafe fn upload_asset_chunked(assets_url: &str, sha: &str, path: &std::path::Path) -> bool {
        let Ok(bytes) = std::fs::read(path) else { return false };
        let Ok(upload_token) = prism_core::upload_token::new_upload_token() else { return false };
        let upload_headers = format!("Content-Type: application/octet-stream\r\nX-Upload-Token: {upload_token}");
        let mut offset: usize = 0;
        let mut last_staged: Option<usize> = None;
        let mut throttled = 0u32;
        while offset < bytes.len() {
            let end = (offset + UPLOAD_CHUNK).min(bytes.len());
            let url = format!("{assets_url}/{sha}?offset={offset}");
            let chunk = &bytes[offset..end];
            match http_request("PUT", &url, Some(&upload_headers), chunk) {
                Ok((code, body)) if (200..300).contains(&code) => {
                    let v = serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default();
                    match v.get("status").and_then(|s| s.as_str()) {
                        Some("stored") | Some("exists") => return true,
                        _ => {
                            offset = v
                                .get("offset")
                                .and_then(|o| o.as_u64())
                                .map(|o| o as usize)
                                .unwrap_or(end);
                            last_staged = None;
                            throttled = 0;
                        }
                    }
                }
                Ok((429, body)) => {
                    // Rate limited — wait out the window (the server's retryAfter
                    // when present) and retry the same offset.
                    throttled += 1;
                    if throttled > MAX_THROTTLE_RETRIES {
                        return false;
                    }
                    let secs = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("retryAfter").and_then(|r| r.as_f64()))
                        .unwrap_or(5.0)
                        .clamp(1.0, 120.0);
                    std::thread::sleep(std::time::Duration::from_secs_f64(secs));
                }
                Ok((409, body)) => {
                    // Resume where the server actually is; the same answer twice
                    // means we're not making progress — give up.
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
                }
                _ => return false,
            }
        }
        false // ran out of local bytes without the server confirming the store
    }

    /// Export the whole local library to a single `.zip` the user can copy to the
    /// server machine and ingest. Runs off the UI thread (a big library is slow).
    unsafe fn export_library(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        if st.working {
            set_status(hwnd, "Busy — wait for the current analysis to finish.");
            return;
        }
        if !ensure_analyzer(st) {
            set_status(hwnd, "Library unavailable.");
            return;
        }
        let analyzer = st.analyzer.clone();
        let Some(path) = pick_save_file(hwnd) else { return };
        set_status(hwnd, "Exporting library…");
        let hwnd_i = hwnd.0 as isize;
        std::thread::spawn(move || {
            let text = match analyzer.lock().unwrap().as_ref() {
                Some(a) => match a.export_bundle(std::path::Path::new(&path)) {
                    Ok(0) => "Library is empty — analyze a disc first.".to_string(),
                    Ok(n) => format!("Exported {n} builds → {path}"),
                    Err(e) => format!("Export failed: {e}"),
                },
                None => "Library unavailable.".to_string(),
            };
            post_service_result(hwnd_i, text);
        });
    }

    fn post_service_result(hwnd_i: isize, text: String) {
        let ptr = Box::into_raw(Box::new(text));
        // SAFETY: `ptr` is a live `Box<String>` matching what `on_service_result` reclaims.
        // If the window is gone PostMessageW fails; take the allocation back to avoid a leak.
        unsafe {
            if PostMessageW(
                HWND(hwnd_i as *mut core::ffi::c_void),
                WM_APP_SERVICE,
                WPARAM(0),
                LPARAM(ptr as isize),
            )
            .is_err()
            {
                drop(Box::from_raw(ptr));
            }
        }
    }

    unsafe fn on_service_result(hwnd: HWND, lparam: LPARAM) {
        let ptr = lparam.0 as *mut String;
        if ptr.is_null() {
            return;
        }
        let text = *Box::from_raw(ptr);
        // Multi-line similarity output goes to the document pane; one-liners to status.
        if text.contains('\n') {
            if let Some(st) = state(hwnd) {
                let body = text.replace('\n', "\r\n");
                let wbody = wide(&body);
                let _ = SetWindowTextW(st.edit, PCWSTR(wbody.as_ptr()));
            }
        }
        set_status(hwnd, text.lines().next().unwrap_or("").trim());
    }

    /// Native WinHTTP `POST <url>` with a JSON body. Returns (status_code, body).
    unsafe fn http_post_json(url: &str, body: &str) -> std::result::Result<(u32, String), String> {
        http_request("POST", url, Some("Content-Type: application/json"), body.as_bytes())
    }

    /// Native WinHTTP request with an arbitrary verb, optional extra header line,
    /// and raw byte body (empty = no body). Returns (status_code, body).
    unsafe fn http_request(
        verb: &str,
        url: &str,
        header: Option<&str>,
        body: &[u8],
    ) -> std::result::Result<(u32, String), String> {
        // Parse scheme://host[:port]/path (minimal; http/https only).
        let (secure, rest) = if let Some(r) = url.strip_prefix("https://") {
            (true, r)
        } else if let Some(r) = url.strip_prefix("http://") {
            (false, r)
        } else {
            return Err("URL must be http(s)".into());
        };
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        let (host, port) = match authority.rfind(':') {
            Some(i) => (
                &authority[..i],
                authority[i + 1..].parse::<u16>().map_err(|_| "bad port")?,
            ),
            None => (authority, if secure { 443 } else { 80 }),
        };

        let host_w = wide(host);
        let verb_w = wide(verb);
        let path_w = wide(path);
        let headers_w = header.map(wide);

        let session = WinHttpOpen(
            w!("prism-win"),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        );
        if session.is_null() {
            return Err("WinHttpOpen failed".into());
        }
        // Bound every phase so a hung server can't wedge the worker thread forever
        // (resolve 10s, connect 10s, send 30s, receive 30s; milliseconds).
        let _ = WinHttpSetTimeouts(session, 10_000, 10_000, 30_000, 30_000);
        let result = (|| {
            let conn = WinHttpConnect(session, PCWSTR(host_w.as_ptr()), port, 0);
            if conn.is_null() {
                return Err("WinHttpConnect failed".to_string());
            }
            let flags = if secure { WINHTTP_FLAG_SECURE } else { WINHTTP_OPEN_REQUEST_FLAGS(0) };
            let req = WinHttpOpenRequest(
                conn,
                PCWSTR(verb_w.as_ptr()),
                PCWSTR(path_w.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                std::ptr::null_mut(),
                flags,
            );
            if req.is_null() {
                let _ = WinHttpCloseHandle(conn);
                return Err("WinHttpOpenRequest failed".to_string());
            }

            let sent = WinHttpSendRequest(
                req,
                headers_w.as_deref().map(|h| &h[..h.len() - 1]), // sans NUL
                if body.is_empty() {
                    None
                } else {
                    Some(body.as_ptr() as *const core::ffi::c_void)
                },
                body.len() as u32,
                body.len() as u32,
                0,
            )
            .is_ok()
                && WinHttpReceiveResponse(req, std::ptr::null_mut()).is_ok();

            let out = if sent {
                let code = query_status_code(req).unwrap_or(0);
                let body = read_all(req);
                Ok((code, body))
            } else {
                Err("WinHttpSendRequest failed".to_string())
            };
            let _ = WinHttpCloseHandle(req);
            let _ = WinHttpCloseHandle(conn);
            out
        })();
        let _ = WinHttpCloseHandle(session);
        result
    }

    unsafe fn query_status_code(req: *mut core::ffi::c_void) -> Option<u32> {
        let mut code: u32 = 0;
        let mut len = std::mem::size_of::<u32>() as u32;
        let ok = WinHttpQueryHeaders(
            req,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut code as *mut u32 as *mut core::ffi::c_void),
            &mut len,
            std::ptr::null_mut(),
        )
        .is_ok();
        if ok {
            Some(code)
        } else {
            None
        }
    }

    unsafe fn read_all(req: *mut core::ffi::c_void) -> String {
        // Every expected response is small JSON; cap the accumulation so a
        // compromised or misbehaving endpoint can't stream unbounded data into
        // memory.
        const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
        let mut data: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            let mut read: u32 = 0;
            if WinHttpReadData(
                req,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
                &mut read,
            )
            .is_err()
                || read == 0
            {
                break;
            }
            data.extend_from_slice(&buf[..read as usize]);
            if data.len() >= MAX_RESPONSE_BYTES {
                break;
            }
        }
        String::from_utf8_lossy(&data).into_owned()
    }

    // ---- modal nickname prompt ----

    struct PromptState {
        edit: HWND,
        result: Option<String>,
        done: bool,
    }

    const IDC_PROMPT_OK: usize = 100;
    const IDC_PROMPT_CANCEL: usize = 101;

    unsafe fn prompt_nickname(owner: HWND) -> Option<String> {
        let hinstance = GetModuleHandleW(None).ok()?;
        let class = w!("PrismPrompt");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(prompt_proc),
            hInstance: hinstance.into(),
            lpszClassName: class,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hIcon: LoadIconW(hinstance, APP_ICON_ID).unwrap_or_default(),
            hbrBackground: HBRUSH(6 as *mut core::ffi::c_void),
            ..Default::default()
        };
        RegisterClassW(&wc); // idempotent enough for a one-window app

        let mut ps = PromptState { edit: HWND::default(), result: None, done: false };
        let dlg = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("Submit build"),
            WS_POPUPWINDOW | WS_CAPTION | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            360,
            150,
            owner,
            None,
            hinstance,
            Some(&mut ps as *mut PromptState as *const core::ffi::c_void),
        )
        .ok()?;

        let _ = EnableWindow(owner, false);
        let mut msg = MSG::default();
        while !ps.done && GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if !IsDialogMessageW(dlg, &msg).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        let _ = EnableWindow(owner, true);
        let _ = SetForegroundWindow(owner);
        let _ = DestroyWindow(dlg);
        ps.result.take()
    }

    extern "system" fn prompt_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe {
            match msg {
                WM_CREATE => {
                    let cs = lparam.0 as *const CREATESTRUCTW;
                    let ps = (*cs).lpCreateParams as *mut PromptState;
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, ps as isize);
                    let hinst = (*cs).hInstance;
                    let _ = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("STATIC"),
                        w!("Nickname for attribution:"),
                        WS_CHILD | WS_VISIBLE,
                        12, 12, 320, 18, hwnd, None, hinst, None,
                    );
                    let edit = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("EDIT"),
                        PCWSTR::null(),
                        WS_CHILD | WS_VISIBLE | WS_BORDER | WINDOW_STYLE(ES_AUTOHSCROLL as u32),
                        12, 34, 320, 24, hwnd, None, hinst, None,
                    )
                    .unwrap_or_default();
                    let _ = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("Submit"),
                        WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_DEFPUSHBUTTON as u32),
                        160, 72, 80, 26, hwnd,
                        HMENU(IDC_PROMPT_OK as *mut core::ffi::c_void), hinst, None,
                    );
                    let _ = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        w!("BUTTON"),
                        w!("Cancel"),
                        WS_CHILD | WS_VISIBLE,
                        252, 72, 80, 26, hwnd,
                        HMENU(IDC_PROMPT_CANCEL as *mut core::ffi::c_void), hinst, None,
                    );
                    if let Some(ps) = (ps as *mut PromptState).as_mut() {
                        ps.edit = edit;
                    }
                    LRESULT(0)
                }
                WM_COMMAND => {
                    let id = (wparam.0 & 0xffff) as usize;
                    let ps = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PromptState;
                    if let Some(ps) = ps.as_mut() {
                        if id == IDC_PROMPT_OK {
                            ps.result = Some(read_edit_text(ps.edit));
                            ps.done = true;
                        } else if id == IDC_PROMPT_CANCEL {
                            ps.result = None;
                            ps.done = true;
                        }
                    }
                    LRESULT(0)
                }
                WM_CLOSE => {
                    let ps = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut PromptState;
                    if let Some(ps) = ps.as_mut() {
                        ps.done = true;
                    }
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, msg, wparam, lparam),
            }
        }
    }

    unsafe fn read_edit_text(edit: HWND) -> String {
        let len = GetWindowTextLengthW(edit);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(edit, &mut buf);
        String::from_utf16_lossy(&buf[..n as usize])
    }

    // ---- library mode (in-app, non-modal browser; usable during import) ----

    const IDC_LIB_SEARCH: usize = 200;
    const IDC_LIB_COMBO: usize = 201;
    const IDC_LIB_LIST: usize = 202;

    /// Switch the main window into library mode and populate it.
    unsafe fn show_library(hwnd: HWND) {
        ensure_reader(hwnd);
        if let Some(st) = state(hwnd) {
            st.library_mode = true;
        }
        populate_systems_combo(hwnd);
        refresh_library(hwnd);
        apply_mode(hwnd);
    }

    /// Lazily open the read-only DB connection used by the browser (separate from the
    /// analyzer, so queries don't block on an in-progress import).
    unsafe fn ensure_reader(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        if st.reader.is_some() {
            return;
        }
        if !ensure_analyzer(st) {
            return;
        }
        st.reader = st.analyzer.lock().unwrap().as_ref().and_then(|a| a.open_reader().ok());
    }

    /// Fill the system-filter combo from the library (resets selection to "All").
    unsafe fn populate_systems_combo(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        let systems = st.reader.as_ref().and_then(|r| r.list_systems().ok()).unwrap_or_default();
        let _ = SendMessageW(st.lib_combo, CB_RESETCONTENT, WPARAM(0), LPARAM(0));
        let mut all = wide("All systems");
        let _ = SendMessageW(st.lib_combo, CB_ADDSTRING, WPARAM(0), LPARAM(all.as_mut_ptr() as isize));
        for s in &systems {
            let mut sw = wide(s);
            let _ = SendMessageW(st.lib_combo, CB_ADDSTRING, WPARAM(0), LPARAM(sw.as_mut_ptr() as isize));
        }
        let _ = SendMessageW(st.lib_combo, CB_SETCURSEL, WPARAM(0), LPARAM(0));
        st.lib_systems = systems;
    }

    /// Re-run the library query for the current search/filter/sort and repopulate the list.
    unsafe fn refresh_library(hwnd: HWND) {
        let Some(st) = state(hwnd) else { return };
        let rows = {
            let Some(reader) = st.reader.as_ref() else { return };
            let q = read_edit_text(st.lib_search);
            let q = q.trim().to_string();
            let sel = SendMessageW(st.lib_combo, CB_GETCURSEL, WPARAM(0), LPARAM(0)).0;
            let system = if sel <= 0 { None } else { st.lib_systems.get((sel - 1) as usize).cloned() };
            reader
                .search_builds(
                    if q.is_empty() { None } else { Some(q.as_str()) },
                    system.as_deref(),
                    st.lib_sort,
                    st.lib_desc,
                    10_000,
                    0,
                )
                .unwrap_or_default()
        };
        let _ = SendMessageW(st.lib_list, LVM_DELETEALLITEMS, WPARAM(0), LPARAM(0));
        st.lib_rows.clear();
        for (i, r) in rows.iter().enumerate() {
            lib_insert_row(st.lib_list, i as i32, r);
            st.lib_rows.push(r.sha256.clone());
        }
    }

    unsafe fn lib_add_columns(list: HWND) {
        for (idx, title, cx) in [
            (0i32, w!("Title"), 320i32),
            (1, w!("System"), 120),
            (2, w!("Files"), 70),
            (3, w!("Size"), 90),
            (4, w!("Analyzed"), 110),
        ] {
            let mut col = LVCOLUMNW::default();
            col.mask = LVCF_TEXT | LVCF_WIDTH | LVCF_SUBITEM;
            col.fmt = LVCFMT_LEFT;
            col.cx = cx;
            col.iSubItem = idx;
            col.pszText = PWSTR(title.as_ptr() as *mut u16);
            let _ = SendMessageW(list, LVM_INSERTCOLUMNW, WPARAM(idx as usize), LPARAM(&col as *const _ as isize));
        }
    }

    unsafe fn lib_insert_row(list: HWND, i: i32, r: &prism_core::db::LibraryRow) {
        let cells = [
            r.name.clone(),
            r.system.clone(),
            r.file_count.to_string(),
            summary::human_size(r.total_size),
            summary::fmt_unix_date(r.analyzed_at),
        ];
        let mut name_w = wide(&cells[0]);
        let mut item = LVITEMW::default();
        item.mask = LVIF_TEXT;
        item.iItem = i;
        item.iSubItem = 0;
        item.pszText = PWSTR(name_w.as_mut_ptr());
        let inserted =
            SendMessageW(list, LVM_INSERTITEMW, WPARAM(0), LPARAM(&item as *const _ as isize)).0 as i32;
        for sub in 1..cells.len() {
            let mut cw = wide(&cells[sub]);
            let mut s = LVITEMW::default();
            s.mask = LVIF_TEXT;
            s.iItem = inserted;
            s.iSubItem = sub as i32;
            s.pszText = PWSTR(cw.as_mut_ptr());
            let _ = SendMessageW(list, LVM_SETITEMW, WPARAM(0), LPARAM(&s as *const _ as isize));
        }
    }

    /// Bridges core progress to the UI thread: queues an event and pokes the window.
    struct WinObserver {
        hwnd: isize,
        events: Arc<Mutex<VecDeque<UiEvent>>>,
        cancel: Arc<AtomicBool>,
    }

    impl ProgressObserver for WinObserver {
        fn on_event(&self, ev: Event) {
            let ui = match ev {
                Event::BatchItem { index, total, name } => UiEvent::Batch { index, total, name },
                Event::CounterOpen { id, label, total, .. } => UiEvent::Open { id, label, total },
                Event::Progress { id, count } => UiEvent::Progress { id, count },
                Event::CounterClose { id } => UiEvent::Close { id },
                Event::Message(text) => UiEvent::Message(text),
            };
            self.events.lock().unwrap().push_back(ui);
            unsafe {
                let _ = PostMessageW(
                    HWND(self.hwnd as *mut core::ffi::c_void),
                    WM_APP_PROGRESS,
                    WPARAM(0),
                    LPARAM(0),
                );
            }
        }

        fn is_cancelled(&self) -> bool {
            self.cancel.load(Ordering::SeqCst)
        }
    }
}
