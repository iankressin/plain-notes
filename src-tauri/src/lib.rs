// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::command;
use tauri::Manager;
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
#[cfg(target_os = "windows")]
use window_vibrancy::apply_acrylic;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteInfo {
    pub id: String,          // filename without .md
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
        std::env::current_dir().unwrap_or_default().join("PlainNotes")
    }
}

fn ensure_dir(path: &Path) {
    let _ = fs::create_dir_all(path);
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
                if line.trim() == "---" { break; }
            }
        }
    }

    // title = first non-empty, non-frontmatter line, strip leading #
    for line in content.lines() {
        let t = line.trim();
        if t.is_empty() || t == "---" || t.starts_with("pinned:") { continue; }
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

#[command]
fn get_default_notes_dir() -> String {
    get_notes_dir().to_string_lossy().to_string()
}

#[command]
async fn list_notes() -> Result<Vec<NoteInfo>, String> {
    let dir = get_notes_dir();
    ensure_dir(&dir);

    let mut notes = vec![];
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                if let Ok(meta) = fs::metadata(&path) {
                    let content = fs::read_to_string(&path).unwrap_or_default();
                    let (title, pinned) = extract_title_and_pinned(&content);
                    let id = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                    let mtime = meta.modified()
                        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
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
    notes.sort_by(|a, b| {
        match (a.pinned, b.pinned) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => b.mtime.cmp(&a.mtime),
        }
    });

    Ok(notes)
}

#[command]
async fn read_note(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[command]
async fn write_note(path: String, content: String) -> Result<(), String> {
    // Ensure parent
    if let Some(parent) = Path::new(&path).parent() {
        ensure_dir(parent);
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[command]
async fn create_note() -> Result<NoteInfo, String> {
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

    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    let mtime = meta.modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);

    Ok(NoteInfo {
        id: filename.trim_end_matches(".md").to_string(),
        path: path.to_string_lossy().to_string(),
        title: "New Note".to_string(),
        mtime,
        pinned: false,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            get_default_notes_dir,
            list_notes,
            read_note,
            write_note,
            create_note
        ])
        .setup(|app| {
            // Ensure default notes dir exists on launch
            let dir = get_notes_dir();
            ensure_dir(&dir);
            println!("[plain-notes] Notes folder: {}", dir.display());

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
