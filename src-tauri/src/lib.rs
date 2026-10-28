// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::command;
use tauri::{Emitter, Manager};

use notify_debouncer_full::new_debouncer;
use notify_debouncer_full::notify::{EventKind, RecursiveMode};
use notify_debouncer_full::DebounceEventResult;
#[cfg(target_os = "windows")]
use window_vibrancy::apply_acrylic;
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteInfo {
    pub id: String, // filename without .md
    pub path: String,
    pub title: String,
    pub mtime: u64,
    pub pinned: bool,
}

fn get_notes_dir() -> PathBuf {
    if let Some(dir) = dirs::document_dir() {
        dir.join("PlainNotes")
    } else {
        // fallback
        std::env::current_dir()
            .unwrap_or_default()
            .join("PlainNotes")
    }
}

fn ensure_dir(path: &Path) {
    let _ = fs::create_dir_all(path);
}

fn get_index_path() -> PathBuf {
    // A cache: losing it only costs one background re-read of every note.
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("plain-notes")
        .join("notes-index.json")
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
        })
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone)]
struct IndexEntry {
    mtime_ms: u64,
    title: String,
    pinned: bool,
}

/// Title and pinned flag of each note, keyed by path and kept outside the
/// notes folder, so listing notes never reads note bodies. The notes folder
/// lives in ~/Documents, which iCloud can evict to placeholder files; reading
/// an evicted note blocks until iCloud downloads it (~2s each).
struct NoteIndex {
    file: PathBuf,
    entries: Mutex<HashMap<String, IndexEntry>>,
}

impl NoteIndex {
    fn load(file: PathBuf) -> Self {
        let entries = fs::read_to_string(&file)
            .ok()
            .and_then(|txt| serde_json::from_str(&txt).ok())
            .unwrap_or_default();
        NoteIndex {
            file,
            entries: Mutex::new(entries),
        }
    }

    fn get(&self, path: &str) -> Option<IndexEntry> {
        self.entries.lock().ok()?.get(path).cloned()
    }

    /// Record a note whose content is already in hand.
    fn set(&self, path: &str, content: &str, mtime_ms: u64) {
        let (title, pinned) = extract_title_and_pinned(content);
        if let Ok(mut map) = self.entries.lock() {
            map.insert(
                path.to_string(),
                IndexEntry {
                    mtime_ms,
                    title,
                    pinned,
                },
            );
        }
    }

    /// Re-read `path` only if it changed since it was indexed, and drop it if
    /// it is gone. Returns true if the index changed. Can block on an iCloud
    /// download, so keep it off any path the UI waits on.
    fn refresh(&self, path: &str) -> bool {
        let Ok(meta) = fs::metadata(path) else {
            return self
                .entries
                .lock()
                .is_ok_and(|mut map| map.remove(path).is_some());
        };
        let mtime = mtime_ms(&meta);
        if self.get(path).is_some_and(|e| e.mtime_ms == mtime) {
            return false;
        }
        let Ok(content) = fs::read_to_string(path) else {
            return false;
        };
        self.set(path, &content, mtime);
        true
    }

    /// Drop entries for notes not in `paths`. Returns true if any were dropped.
    fn retain(&self, paths: &[String]) -> bool {
        let Ok(mut map) = self.entries.lock() else {
            return false;
        };
        let before = map.len();
        map.retain(|p, _| paths.contains(p));
        map.len() != before
    }

    fn save(&self) {
        // Hold the lock across the write so concurrent saves can't interleave.
        let Ok(map) = self.entries.lock() else { return };
        let Ok(json) = serde_json::to_string(&*map) else {
            return;
        };
        if let Some(dir) = self.file.parent() {
            ensure_dir(dir);
        }
        let tmp = self.file.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &self.file);
        }
    }
}

/// Bring the index up to date with the notes folder on a background thread.
/// Notes added or changed while the app was closed get read here, which may
/// wait on iCloud; the list shows them as "Loading…" until this finishes.
fn start_indexer(app: tauri::AppHandle, dir: PathBuf) {
    std::thread::spawn(move || {
        let paths: Vec<String> = fs::read_dir(&dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
                    .map(|p| p.to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();

        let index = app.state::<NoteIndex>();
        let mut changed = index.retain(&paths);
        for p in &paths {
            changed |= index.refresh(p);
        }
        if changed {
            index.save();
            // Only titles changed, not note content, so no open note needs reloading.
            let _ = app.emit("notes-changed", NotesChangedPayload { paths: vec![] });
        }
    });
}

/// Payload sent to the frontend when notes change on disk.
#[derive(Clone, Serialize)]
struct NotesChangedPayload {
    paths: Vec<String>,
}

/// Tracks paths the app itself just wrote, so the file watcher can ignore the
/// resulting echo events instead of triggering a refresh/reload loop.
#[derive(Default)]
struct SelfWrites(Mutex<HashMap<String, Instant>>);

const SELF_WRITE_TTL: Duration = Duration::from_millis(1500);

fn mark_self_write(self_writes: &SelfWrites, path: &str) {
    if let Ok(mut map) = self_writes.0.lock() {
        map.insert(path.to_string(), Instant::now());
    }
}

/// True if `path` was written by the app within the TTL window (an echo to ignore).
/// Also prunes stale entries opportunistically.
fn was_self_written(app: &tauri::AppHandle, path: &str) -> bool {
    let state = app.state::<SelfWrites>();
    let Ok(mut map) = state.0.lock() else {
        return false;
    };
    let recent = map.get(path).is_some_and(|t| t.elapsed() < SELF_WRITE_TTL);
    map.retain(|_, t| t.elapsed() < SELF_WRITE_TTL);
    recent
}

/// Watch the notes directory and emit `notes-changed` to the frontend when
/// `.md` files are created/modified/removed by anything other than the app itself.
fn start_notes_watcher(app: tauri::AppHandle, dir: PathBuf) {
    let watcher = new_debouncer(
        Duration::from_millis(300),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let mut changed: Vec<String> = Vec::new();
            for ev in &events {
                if !matches!(
                    ev.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) {
                    continue;
                }
                for p in &ev.paths {
                    if p.extension().and_then(|e| e.to_str()) != Some("md") {
                        continue;
                    }
                    let ps = p.to_string_lossy().to_string();
                    if was_self_written(&app, &ps) {
                        continue;
                    }
                    changed.push(ps);
                }
            }
            if !changed.is_empty() {
                changed.sort();
                changed.dedup();
                // These notes were just written by something else, so they are
                // local and quick to read. refresh skips any whose mtime is
                // unchanged, so iCloud evicting a note doesn't download it again.
                let index = app.state::<NoteIndex>();
                let mut index_changed = false;
                for p in &changed {
                    index_changed |= index.refresh(p);
                }
                if index_changed {
                    index.save();
                }
                let _ = app.emit("notes-changed", NotesChangedPayload { paths: changed });
            }
        },
    );

    match watcher {
        Ok(mut debouncer) => {
            if let Err(e) = debouncer.watch(&dir, RecursiveMode::NonRecursive) {
                eprintln!("[plain-notes] failed to watch notes dir: {e:?}");
                return;
            }
            // The debouncer stops watching when dropped; keep it alive for the
            // app's lifetime. (Leaking is intentional for an always-on watcher.)
            std::mem::forget(debouncer);
        }
        Err(e) => eprintln!("[plain-notes] failed to create notes watcher: {e:?}"),
    }
}

fn extract_title_and_pinned(content: &str) -> (String, bool) {
    let mut pinned = false;
    let mut lines = content.lines();

    // very light frontmatter support for pinned
    if let Some(first) = lines.next() {
        if first.trim() == "---" {
            // scan a few lines
            for line in lines.by_ref().take(6) {
                if line.trim().starts_with("pinned:") && line.contains("true") {
                    pinned = true;
                }
                if line.trim() == "---" {
                    break;
                }
            }
        }
    }

    // title = first non-empty, non-frontmatter line, strip leading #
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t == "---" || t.starts_with("pinned:") {
            continue;
        }
        let title = t.trim_start_matches('#').trim().to_string();
        if !title.is_empty() {
            return (title, pinned);
        }
    }
    ("Untitled Note".to_string(), pinned)
}

#[command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Fully quit the application (terminate the process). Bound to ESC in the UI.
#[command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[command]
fn get_default_notes_dir() -> String {
    get_notes_dir().to_string_lossy().to_string()
}

#[command]
async fn list_notes(index: tauri::State<'_, NoteIndex>) -> Result<Vec<NoteInfo>, String> {
    let dir = get_notes_dir();
    ensure_dir(&dir);

    let mut notes = vec![];
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Ok(meta) = fs::metadata(&path) {
                    // Index only: reading the body would block on an iCloud
                    // download for each evicted note.
                    let (title, pinned) = index
                        .get(&path.to_string_lossy())
                        .map_or_else(|| ("Loading…".to_string(), false), |e| (e.title, e.pinned));
                    let id = path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string();
                    let mtime = meta
                        .modified()
                        .map(|t| {
                            t.duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_secs()
                        })
                        .unwrap_or(0);

                    notes.push(NoteInfo {
                        id,
                        path: path.to_string_lossy().to_string(),
                        title,
                        mtime,
                        pinned,
                    });
                }
            }
        }
    }

    // Sort: pinned first, then reverse chrono (mtime)
    notes.sort_by(|a, b| match (a.pinned, b.pinned) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => b.mtime.cmp(&a.mtime),
    });

    Ok(notes)
}

#[command]
async fn read_note(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[command]
async fn write_note(
    path: String,
    content: String,
    self_writes: tauri::State<'_, SelfWrites>,
    index: tauri::State<'_, NoteIndex>,
) -> Result<(), String> {
    // Ensure parent
    if let Some(parent) = Path::new(&path).parent() {
        ensure_dir(parent);
    }
    fs::write(&path, &content).map_err(|e| e.to_string())?;
    mark_self_write(&self_writes, &path);
    if let Ok(meta) = fs::metadata(&path) {
        index.set(&path, &content, mtime_ms(&meta));
        index.save();
    }
    Ok(())
}

#[command]
async fn create_note(
    self_writes: tauri::State<'_, SelfWrites>,
    index: tauri::State<'_, NoteIndex>,
) -> Result<NoteInfo, String> {
    let dir = get_notes_dir();
    ensure_dir(&dir);

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let filename = format!("note-{}.md", timestamp);
    let path = dir.join(&filename);

    let initial = "# New Note\n\n";
    fs::write(&path, initial).map_err(|e| e.to_string())?;
    mark_self_write(&self_writes, &path.to_string_lossy());

    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    index.set(&path.to_string_lossy(), initial, mtime_ms(&meta));
    index.save();
    let mtime = meta
        .modified()
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        })
        .unwrap_or(0);

    Ok(NoteInfo {
        id: filename.trim_end_matches(".md").to_string(),
        path: path.to_string_lossy().to_string(),
        title: "New Note".to_string(),
        mtime,
        pinned: false,
    })
}

/// Find the bundled MCP server binary. When bundled it sits next to the app
/// executable as `plain-notes-mcp`; in dev it may carry the target-triple suffix.
fn resolve_mcp_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let direct = dir.join("plain-notes-mcp");
    if direct.exists() {
        return Some(direct);
    }
    let suffixed = dir.join(format!(
        "plain-notes-mcp-{}-apple-darwin",
        std::env::consts::ARCH
    ));
    if suffixed.exists() {
        return Some(suffixed);
    }
    None
}

/// Insert/replace the `plain-notes` MCP server entry in a Claude config value,
/// preserving every other key. Pure (no I/O) so it can be unit-tested.
fn upsert_mcp_server(
    mut root: serde_json::Value,
    name: &str,
    command: &str,
    notes_dir: &str,
) -> Result<serde_json::Value, String> {
    if root.is_null() {
        root = serde_json::json!({});
    }
    if !root.is_object() {
        return Err("config root is not a JSON object".to_string());
    }
    let obj = root.as_object_mut().unwrap();
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        return Err("'mcpServers' is not a JSON object".to_string());
    }
    servers.as_object_mut().unwrap().insert(
        name.to_string(),
        serde_json::json!({
            "command": command,
            "args": ["--notes-dir", notes_dir],
        }),
    );
    Ok(root)
}

/// Register the bundled MCP server in Claude Desktop's config. Preserves any
/// other servers, backs up the existing file, and writes atomically. Never
/// clobbers a config it cannot parse.
#[command]
fn connect_claude_desktop() -> Result<String, String> {
    let bin = resolve_mcp_binary().ok_or_else(|| {
        "Could not find the plain-notes-mcp binary next to the app. Build it first \
         (cd mcp-server && bun run compile)."
            .to_string()
    })?;
    let bin_str = bin.to_string_lossy().to_string();
    let notes_dir = get_notes_dir().to_string_lossy().to_string();

    let cfg_dir = dirs::config_dir()
        .ok_or_else(|| "Could not resolve the configuration directory.".to_string())?
        .join("Claude");
    let cfg_path = cfg_dir.join("claude_desktop_config.json");

    // Read existing config, or start fresh. Never overwrite an unparseable file.
    let root: serde_json::Value = if cfg_path.exists() {
        let txt = fs::read_to_string(&cfg_path)
            .map_err(|e| format!("Failed to read Claude config: {e}"))?;
        if txt.trim().is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&txt).map_err(|_| {
                "Your claude_desktop_config.json contains invalid JSON. Fix it, or add the \
                 server manually (see mcp-server/README.md)."
                    .to_string()
            })?
        }
    } else {
        serde_json::json!({})
    };

    // Back up before modifying.
    if cfg_path.exists() {
        let _ = fs::copy(&cfg_path, cfg_dir.join("claude_desktop_config.json.bak"));
    }

    let updated = upsert_mcp_server(root, "plain-notes", &bin_str, &notes_dir)?;

    // Write atomically (temp file + rename).
    ensure_dir(&cfg_dir);
    let pretty = serde_json::to_string_pretty(&updated).map_err(|e| e.to_string())?;
    let tmp = cfg_path.with_extension("json.tmp");
    fs::write(&tmp, pretty).map_err(|e| format!("Failed to write config: {e}"))?;
    fs::rename(&tmp, &cfg_path).map_err(|e| format!("Failed to save config: {e}"))?;

    Ok(
        "Connected to Claude Desktop. Fully quit and reopen Claude to load the Plain Notes tools."
            .to_string(),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(SelfWrites::default())
        .manage(NoteIndex::load(get_index_path()))
        .invoke_handler(tauri::generate_handler![
            greet,
            quit_app,
            get_default_notes_dir,
            list_notes,
            read_note,
            write_note,
            create_note,
            connect_claude_desktop
        ])
        .setup(|app| {
            // Ensure default notes dir exists on launch
            let dir = get_notes_dir();
            ensure_dir(&dir);
            println!("[plain-notes] Notes folder: {}", dir.display());

            start_indexer(app.handle().clone(), dir.clone());

            // Watch the notes dir so external edits (e.g. from the MCP server)
            // live-update the UI. Runs on the debouncer's own thread.
            start_notes_watcher(app.handle().clone(), dir.clone());

            // Raycast-style frosted glass. The radius MUST equal the CSS
            // border-radius on .note-window (app.css) so the native effect view
            // and the clipped webview content share the same rounded corners.
            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            #[cfg(target_os = "macos")]
            apply_vibrancy(
                &window,
                NSVisualEffectMaterial::HudWindow,
                Some(NSVisualEffectState::Active), // stay frosted even when not key (always-on-top)
                Some(12.0),
            )
            .expect("apply_vibrancy is only supported on macOS");

            #[cfg(target_os = "windows")]
            let _ = apply_acrylic(&window, Some((28, 28, 30, 180))); // graceful fallback

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("plain-notes-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        ensure_dir(&dir);
        dir
    }

    fn set_mtime(path: &Path, t: std::time::SystemTime) {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(t)
            .unwrap();
    }

    #[test]
    fn index_rereads_a_note_only_when_its_mtime_changes() {
        let dir = temp_dir("refresh");
        let note = dir.join("a.md");
        let p = note.to_string_lossy().to_string();
        let index = NoteIndex::load(dir.join("index.json"));

        fs::write(&note, "# First").unwrap();
        assert!(index.refresh(&p));
        assert_eq!(index.get(&p).unwrap().title, "First");

        // New content but the same mtime: the cached title stays, so no read happened.
        let mtime = fs::metadata(&note).unwrap().modified().unwrap();
        fs::write(&note, "# Second").unwrap();
        set_mtime(&note, mtime);
        assert!(!index.refresh(&p));
        assert_eq!(index.get(&p).unwrap().title, "First");

        set_mtime(&note, mtime + Duration::from_secs(5));
        assert!(index.refresh(&p));
        assert_eq!(index.get(&p).unwrap().title, "Second");

        fs::remove_file(&note).unwrap();
        assert!(index.refresh(&p));
        assert!(index.get(&p).is_none());
    }

    #[test]
    fn index_survives_reload_and_ignores_a_corrupt_file() {
        let dir = temp_dir("persist");
        let file = dir.join("cache").join("index.json");
        let index = NoteIndex::load(file.clone());
        index.set("/n/a.md", "---\npinned: true\n---\n# Pinned", 7);
        index.save();

        let entry = NoteIndex::load(file.clone()).get("/n/a.md").unwrap();
        assert_eq!(
            (entry.title.as_str(), entry.pinned, entry.mtime_ms),
            ("Pinned", true, 7)
        );

        fs::write(&file, "{not json").unwrap();
        assert!(NoteIndex::load(file).get("/n/a.md").is_none());
    }

    #[test]
    fn upsert_preserves_other_servers_and_keys() {
        let existing = serde_json::json!({
            "mcpServers": { "other": { "command": "x" } },
            "theme": "dark"
        });
        let out = upsert_mcp_server(existing, "plain-notes", "/bin/pn", "/notes").unwrap();
        // other server + unrelated keys untouched
        assert_eq!(out["mcpServers"]["other"]["command"], "x");
        assert_eq!(out["theme"], "dark");
        // our entry added correctly
        assert_eq!(out["mcpServers"]["plain-notes"]["command"], "/bin/pn");
        assert_eq!(out["mcpServers"]["plain-notes"]["args"][0], "--notes-dir");
        assert_eq!(out["mcpServers"]["plain-notes"]["args"][1], "/notes");
    }

    #[test]
    fn upsert_creates_structure_from_empty() {
        let out = upsert_mcp_server(serde_json::json!({}), "plain-notes", "/bin/pn", "/n").unwrap();
        assert!(out["mcpServers"]["plain-notes"].is_object());
    }

    #[test]
    fn upsert_replaces_existing_entry() {
        let existing = serde_json::json!({
            "mcpServers": { "plain-notes": { "command": "/old", "args": [] } }
        });
        let out = upsert_mcp_server(existing, "plain-notes", "/new", "/n").unwrap();
        assert_eq!(out["mcpServers"]["plain-notes"]["command"], "/new");
    }

    #[test]
    fn upsert_rejects_non_object_servers() {
        let bad = serde_json::json!({ "mcpServers": 5 });
        assert!(upsert_mcp_server(bad, "plain-notes", "/bin/pn", "/n").is_err());
    }

    #[test]
    fn upsert_rejects_non_object_root() {
        let bad = serde_json::json!([1, 2, 3]);
        assert!(upsert_mcp_server(bad, "plain-notes", "/bin/pn", "/n").is_err());
    }
}
