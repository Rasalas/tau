mod capture;
mod ipc;
mod protocols;
#[cfg(test)]
mod transport_tests;

use std::{error::Error, io::Write, path::Path};
type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn emit(value: serde_json::Value) -> Result<()> {
    println!("{value}");
    std::io::stdout().flush()?;
    Ok(())
}

fn run() -> Result<()> {
    ipc::session_directory()?;
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("check") => emit(serde_json::json!({"feedbackAvailable": capture::check()?})),
        Some("capture") if args.len() == 3 => {
            ipc::ensure_unlocked()?;
            let window = ipc::active_window()?;
            capture::capture(window.address()?, Path::new(&args[2]))?;
            ipc::ensure_unlocked()?;
            let after = ipc::windows()?.into_iter().find(|w| w.address == window.address);
            // Never pair text with a different/closed window or stale geometry.
            let metadata = after.filter(|w| w == &window).map(|w| w.metadata());
            emit(serde_json::json!({"window": metadata}))
        }
        _ => Err("Expected check or capture <directory>".into()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
