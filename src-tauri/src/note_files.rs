use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Serialize)]
pub struct FolderInfo {
    pub path: String,
    pub name: String,
}

pub struct NoteTree {
    pub notes: Vec<PathBuf>,
    pub folders: Vec<FolderInfo>,
}

pub fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn is_note_path(path: &Path, root: &Path) -> bool {
    path.strip_prefix(root).is_ok_and(|relative| {
        relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
            && relative.extension().and_then(|ext| ext.to_str()) == Some("md")
    })
}

fn checked_descendant(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Invalid notes location")?;
    let mut current = root.to_path_buf();
    for part in relative.components() {
        if !matches!(part, Component::Normal(_)) {
            return Err("Invalid notes location".into());
        }
        current.push(part);
        let metadata = fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("Symbolic links cannot be used as notes locations".into());
        }
    }
    Ok(current)
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.chars().any(|c| c.is_control() || "/\\".contains(c))
}

pub fn resolve_folder(root: &Path, folder: &str) -> Result<PathBuf, String> {
    if !folder.is_empty() && !folder.split('/').all(valid_segment) {
        return Err("Invalid folder path".into());
    }
    let path = checked_descendant(root, &root.join(folder))?;
    if !path.is_dir() {
        return Err("Folder does not exist".into());
    }
    Ok(path)
}

pub fn checked_note(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if !is_note_path(path, root) {
        return Err("Invalid note location".into());
    }
    let path = checked_descendant(root, path)?;
    if !path.is_file() {
        return Err("Note does not exist".into());
    }
    Ok(path)
}

pub fn scan(root: &Path) -> Result<NoteTree, String> {
    let mut tree = NoteTree {
        notes: vec![],
        folders: vec![],
    };
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            let path = entry.path();
            if kind.is_dir() {
                tree.folders.push(FolderInfo {
                    path: relative_path(root, &path),
                    name: entry.file_name().to_string_lossy().into_owned(),
                });
                pending.push(path);
            } else if kind.is_file() && is_note_path(&path, root) {
                tree.notes.push(path);
            }
        }
    }
    tree.folders.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(tree)
}

pub fn create_folder(root: &Path, parent: &str, name: &str) -> Result<FolderInfo, String> {
    let name = name.trim();
    if !valid_segment(name) || name.chars().any(|c| ":*?\"<>|".contains(c)) {
        return Err("Enter a folder name without slashes or reserved characters".into());
    }
    let path = resolve_folder(root, parent)?.join(name);
    fs::create_dir(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "A folder or file with that name already exists".into()
        } else {
            e.to_string()
        }
    })?;
    Ok(FolderInfo {
        path: relative_path(root, &path),
        name: name.into(),
    })
}

pub fn create_note(root: &Path, folder: &str, content: &str) -> Result<PathBuf, String> {
    let dir = resolve_folder(root, folder)?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    for suffix in 0.. {
        let name = if suffix == 0 {
            format!("note-{timestamp}.md")
        } else {
            format!("note-{timestamp}-{suffix}.md")
        };
        let path = dir.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(content.as_bytes()) {
                    let _ = fs::remove_file(&path);
                    return Err(error.to_string());
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    unreachable!()
}

pub fn move_note(root: &Path, source: &Path, folder: &str) -> Result<PathBuf, String> {
    let source = checked_note(root, source)?;
    let target = resolve_folder(root, folder)?.join(source.file_name().unwrap());
    if source == target {
        return Ok(source);
    }
    // Creating a link fails if the destination exists; rename would overwrite it.
    fs::hard_link(&source, &target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            "A note with the same filename already exists in that folder".into()
        } else {
            e.to_string()
        }
    })?;
    if let Err(error) = fs::remove_file(&source) {
        let _ = fs::remove_file(&target);
        return Err(error.to_string());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Collection(PathBuf);

    impl Collection {
        fn new() -> Self {
            static NEXT_ID: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "plain-notes-folders-{}-{nonce}-{id}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for Collection {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovers_nested_notes_and_empty_folders() {
        let collection = Collection::new();
        let root = &collection.0;
        fs::create_dir_all(root.join("Work/Project A")).unwrap();
        fs::create_dir(root.join("Empty")).unwrap();
        fs::write(root.join("same.md"), "# Root").unwrap();
        fs::write(root.join("Work/Project A/same.md"), "# Nested").unwrap();
        fs::write(root.join("Work/ignore.txt"), "ignore").unwrap();
        let tree = scan(root).unwrap();
        let mut paths: Vec<_> = tree.notes.iter().map(|p| relative_path(root, p)).collect();
        paths.sort();
        assert_eq!(paths, ["Work/Project A/same.md", "same.md"]);
        assert_eq!(
            tree.folders
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            ["Empty", "Work", "Work/Project A"]
        );
    }

    #[test]
    fn creates_folders_and_distinct_notes_without_overwriting() {
        let collection = Collection::new();
        let root = &collection.0;
        assert_eq!(create_folder(root, "", "Work").unwrap().path, "Work");
        assert_eq!(
            create_folder(root, "Work", "São Paulo").unwrap().path,
            "Work/São Paulo"
        );
        assert!(create_folder(root, "", "Work").is_err());
        let first = create_note(root, "Work/São Paulo", "# First").unwrap();
        let second = create_note(root, "Work/São Paulo", "# Second").unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(first).unwrap(), "# First");
        assert_eq!(fs::read_to_string(second).unwrap(), "# Second");
    }

    #[test]
    fn moves_preserve_content_and_refuse_collisions() {
        let collection = Collection::new();
        let root = &collection.0;
        create_folder(root, "", "Work").unwrap();
        let source = root.join("same.md");
        let target = root.join("Work/same.md");
        let content = "---\npinned: true\n---\n# Title\n\nBody";
        fs::write(&source, content).unwrap();
        fs::write(&target, "# Other").unwrap();
        assert!(move_note(root, &source, "Work").is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), content);
        assert_eq!(fs::read_to_string(&target).unwrap(), "# Other");
        fs::remove_file(&target).unwrap();
        assert_eq!(move_note(root, &source, "Work").unwrap(), target);
        assert!(!source.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), content);
        assert_eq!(move_note(root, &target, "Work").unwrap(), target);
        assert_eq!(move_note(root, &target, "").unwrap(), source);
    }

    #[test]
    fn rejects_invalid_or_missing_destinations() {
        let collection = Collection::new();
        let root = &collection.0;
        for folder in [
            "../outside",
            "/outside",
            "Work/../Other",
            "Work\\Other",
            "Work//Other",
            ".",
        ] {
            assert!(resolve_folder(root, folder).is_err(), "{folder}");
        }
        for name in ["", ".", "..", "a/b", "a\\b"] {
            assert!(create_folder(root, "", name).is_err(), "{name}");
        }
        assert!(create_note(root, "Missing", "text").is_err());
        fs::write(root.join("a.md"), "# A").unwrap();
        assert!(move_note(root, &root.join("a.md"), "Missing").is_err());
        assert!(root.join("a.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn accepts_existing_folder_names_with_punctuation() {
        let collection = Collection::new();
        let root = &collection.0;
        fs::create_dir(root.join("Project: A")).unwrap();
        fs::write(root.join("note.md"), "# Note").unwrap();
        assert_eq!(
            resolve_folder(root, "Project: A").unwrap(),
            root.join("Project: A")
        );
        assert_eq!(
            move_note(root, &root.join("note.md"), "Project: A").unwrap(),
            root.join("Project: A/note.md")
        );
    }

    #[cfg(unix)]
    #[test]
    fn ignores_links_and_refuses_to_use_them() {
        use std::os::unix::fs::symlink;
        let collection = Collection::new();
        let outside = Collection::new();
        let root = &collection.0;
        fs::write(outside.0.join("secret.md"), "# Outside").unwrap();
        symlink(&outside.0, root.join("link")).unwrap();
        symlink(outside.0.join("secret.md"), root.join("linked.md")).unwrap();
        let tree = scan(root).unwrap();
        assert!(tree.notes.is_empty());
        assert!(tree.folders.is_empty());
        assert!(resolve_folder(root, "link").is_err());
        assert!(checked_note(root, &root.join("link/secret.md")).is_err());
        assert!(checked_note(root, &root.join("linked.md")).is_err());
    }
}
