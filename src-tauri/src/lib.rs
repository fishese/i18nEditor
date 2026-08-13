mod files;
pub use files::{
    read_files, walk_folder, write_text, LoadedFile, PickResult, WriteResult,
};

use std::path::PathBuf;
use tauri::command;

#[command]
async fn pick_files() -> PickResult {
    tauri::async_runtime::spawn_blocking(|| {
        let picked = rfd::FileDialog::new()
            .add_filter("i18n", &["ts", "tsx", "js", "jsx"])
            .pick_files()
            .unwrap_or_default();
        let pairs: Vec<(PathBuf, String)> = picked
            .into_iter()
            .map(|path| {
                let name = path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "translations.ts".into());
                (path, name)
            })
            .collect();
        read_files(&pairs)
    })
    .await
    .unwrap_or_default()
}

#[command]
async fn pick_folder() -> PickResult {
    tauri::async_runtime::spawn_blocking(|| {
        match rfd::FileDialog::new().pick_folder() {
            Some(path) => walk_folder(&path),
            None => PickResult::default(),
        }
    })
    .await
    .unwrap_or_default()
}

#[command]
fn write_file(absolute_path: String, text: String) -> WriteResult {
    write_text(PathBuf::from(absolute_path).as_path(), &text)
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![pick_files, pick_folder, write_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
