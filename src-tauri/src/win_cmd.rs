//! Windows process helpers — never flash console windows from a GUI app.
use std::process::Command;

/// CREATE_NO_WINDOW — required for every helper process launched from ModelShaper on Windows.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply flags so child processes do not open visible console windows.
pub fn silence(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Build a silenced Command.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    silence(&mut cmd);
    cmd
}
