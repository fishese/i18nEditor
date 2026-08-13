use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadedFile {
    pub relative_path: String,
    pub absolute_path: String,
    pub text: String,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct PickResult {
    pub files: Vec<LoadedFile>,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct WriteResult {
    pub ok: bool,
    pub error: Option<String>,
}

const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", "out",
];

pub fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.iter().any(|d| name.eq_ignore_ascii_case(d))
}

pub fn should_skip_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name.to_ascii_lowercase().ends_with(".d.ts") {
        return true;
    }
    match path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
    {
        Some(ext) if matches!(ext.as_str(), "ts" | "tsx" | "js" | "jsx") => false,
        _ => true,
    }
}

pub fn read_files(paths: &[(PathBuf, String)]) -> PickResult {
    let mut out = PickResult::default();
    for (path, relative) in paths {
        if should_skip_file(path) {
            continue;
        }
        match fs::read_to_string(path) {
            Ok(text) => out.files.push(LoadedFile {
                relative_path: relative.clone(),
                absolute_path: path.to_string_lossy().into_owned(),
                text,
            }),
            Err(err) => out.errors.push(format!("{relative}: could not read file ({err})")),
        }
    }
    out
}

pub fn walk_folder(root: &Path) -> PickResult {
    let mut out = PickResult::default();
    walk_inner(root, root, &mut out);
    out
}

fn walk_inner(root: &Path, dir: &Path, out: &mut PickResult) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) => {
            out.errors.push(format!(
                "{}: could not read file ({err})",
                display_rel(root, dir)
            ));
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            walk_inner(root, &path, out);
            continue;
        }
        if should_skip_file(&path) {
            continue;
        }
        let relative = display_rel(root, &path);
        match fs::read_to_string(&path) {
            Ok(text) => out.files.push(LoadedFile {
                relative_path: relative,
                absolute_path: path.to_string_lossy().into_owned(),
                text,
            }),
            Err(err) => out.errors.push(format!("{relative}: could not read file ({err})")),
        }
    }
}

fn display_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn write_text(absolute_path: &Path, text: &str) -> WriteResult {
    match fs::write(absolute_path, text) {
        Ok(()) => WriteResult {
            ok: true,
            error: None,
        },
        Err(err) => WriteResult {
            ok: false,
            error: Some(err.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn skip_junk_directories() {
        for name in [
            "node_modules",
            ".git",
            "dist",
            "build",
            "coverage",
            ".next",
            ".turbo",
            "out",
        ] {
            assert!(should_skip_dir(name), "{name}");
        }
        assert!(!should_skip_dir("locales"));
        assert!(!should_skip_dir("src"));
    }

    #[test]
    fn skip_non_translation_files() {
        assert!(should_skip_file(Path::new("foo.d.ts")));
        assert!(should_skip_file(Path::new("readme.md")));
        assert!(should_skip_file(Path::new("en.json")));
        assert!(!should_skip_file(Path::new("en.ts")));
        assert!(!should_skip_file(Path::new("en.tsx")));
        assert!(!should_skip_file(Path::new("fr.js")));
        assert!(!should_skip_file(Path::new("de.jsx")));
    }

    #[test]
    fn walk_skips_node_modules_and_reads_ts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("locales")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("locales/en.ts"), "export default { a: \"A\" };").unwrap();
        fs::write(
            root.join("node_modules/pkg/en.ts"),
            "export default { skip: true };",
        )
        .unwrap();
        fs::write(root.join("notes.md"), "nope").unwrap();
        let result = walk_folder(root);
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let names: Vec<_> = result
            .files
            .iter()
            .map(|f| f.relative_path.replace('\\', "/"))
            .collect();
        assert_eq!(names, vec!["locales/en.ts"]);
        assert!(result.files[0].text.contains("A"));
        assert!(result.files[0].absolute_path.contains("en.ts"));
    }

    #[test]
    fn write_text_overwrites_and_reports_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("en.ts");
        fs::write(&path, "old").unwrap();
        let ok = write_text(&path, "new");
        assert!(ok.ok, "{:?}", ok.error);
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        let missing = write_text(&dir.path().join("nope").join("en.ts"), "x");
        assert!(!missing.ok);
        assert!(missing.error.is_some());
    }
}
