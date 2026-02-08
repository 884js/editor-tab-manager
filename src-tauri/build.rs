fn main() {
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-lib=framework=UserNotifications");
    tauri_build::build()
}
