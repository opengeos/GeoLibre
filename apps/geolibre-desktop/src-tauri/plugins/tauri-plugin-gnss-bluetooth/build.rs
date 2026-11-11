// The commands are implemented only in Kotlin (android/). Tauri forwards a
// `plugin:gnss-bluetooth|<command>` invoke that no Rust handler claims to the
// registered Android plugin, converting the name to lowerCamelCase, so this
// list only has to generate the ACL permissions for them.
const COMMANDS: &[&str] = &[
    "list_devices",
    "connect",
    "disconnect",
    "start_corrections",
    "stop_corrections",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
