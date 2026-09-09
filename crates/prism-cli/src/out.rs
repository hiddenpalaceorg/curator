//! Console-safe line output: `outln!`/`errln!`/`out!` mirror `println!`/
//! `eprintln!`/`print!`, but on a Windows console they end lines with `\r\n`
//! and convert embedded `\n` too. A Windows console can run with newline
//! auto-return disabled (WSL interop's conhost does, for VT passthrough), and
//! there a bare `\n` moves down without returning the carriage, stair-stepping
//! every plain line (the loader is immune: its frames start with `\r`).
//! Redirected streams keep plain `\n`, so piped output is byte-identical.

use std::fmt;
use std::io::{IsTerminal, Write};
use std::sync::OnceLock;

fn stdout_tty() -> bool {
    static V: OnceLock<bool> = OnceLock::new();
    *V.get_or_init(|| std::io::stdout().is_terminal())
}

pub fn stderr_tty() -> bool {
    static V: OnceLock<bool> = OnceLock::new();
    *V.get_or_init(|| std::io::stderr().is_terminal())
}

fn stderr_crlf() -> bool {
    cfg!(windows) && stderr_tty()
}

/// Escape terminal instructions in untrusted text, preserving prose layout.
pub fn terminal_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if (c.is_control() && c != '\n' && c != '\t') || matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') {
            out.extend(c.escape_default());
        } else {
            out.push(c);
        }
    }
    out
}

/// Streaming UTF-8 filter for serializers that write directly to stdout.
pub struct TerminalWriter<W> { inner: W, tty: bool, pending: Vec<u8> }
impl<W: Write> TerminalWriter<W> {
    pub fn new(inner: W, tty: bool) -> Self { Self { inner, tty, pending: vec![] } }
}
impl<W: Write> Write for TerminalWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if !self.tty { self.inner.write_all(buf)?; return Ok(buf.len()); }
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(buf);
        let mut rest = bytes.as_slice();
        while !rest.is_empty() {
            match std::str::from_utf8(rest) {
                Ok(text) => { self.inner.write_all(terminal_text(text).as_bytes())?; break; }
                Err(error) => {
                    let valid = error.valid_up_to();
                    self.inner.write_all(terminal_text(std::str::from_utf8(&rest[..valid]).unwrap()).as_bytes())?;
                    rest = &rest[valid..];
                    if let Some(count) = error.error_len() {
                        for byte in &rest[..count] { write!(self.inner, "\\x{byte:02x}")?; }
                        rest = &rest[count..];
                    } else { self.pending.extend_from_slice(rest); break; }
                }
            }
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        for byte in self.pending.drain(..) { write!(self.inner, "\\x{byte:02x}")?; }
        self.inner.flush()
    }
}

fn emit(w: &mut impl Write, args: fmt::Arguments, tty: bool, crlf: bool, newline: bool) {
    let raw = args.to_string();
    let text = if tty { terminal_text(&raw) } else { raw };
    if crlf {
        let mut s = text.replace('\n', "\r\n");
        if newline {
            s.push_str("\r\n");
        }
        let _ = w.write_all(s.as_bytes());
    } else if newline {
        let _ = writeln!(w, "{text}");
    } else {
        let _ = write!(w, "{text}");
    }
}

pub fn out_line(args: fmt::Arguments) {
    emit(&mut std::io::stdout().lock(), args, stdout_tty(), cfg!(windows) && stdout_tty(), true);
}

pub fn out_raw(args: fmt::Arguments) {
    emit(&mut std::io::stdout().lock(), args, stdout_tty(), cfg!(windows) && stdout_tty(), false);
}

pub fn err_line(args: fmt::Arguments) {
    emit(&mut std::io::stderr().lock(), args, stderr_tty(), stderr_crlf(), true);
}

macro_rules! outln {
    () => { $crate::out::out_line(format_args!("")) };
    ($($arg:tt)*) => { $crate::out::out_line(format_args!($($arg)*)) };
}

macro_rules! out {
    ($($arg:tt)*) => { $crate::out::out_raw(format_args!($($arg)*)) };
}

macro_rules! errln {
    () => { $crate::out::err_line(format_args!("")) };
    ($($arg:tt)*) => { $crate::out::err_line(format_args!($($arg)*)) };
}

pub(crate) use {errln, out, outln};

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escapes_terminal_controls_without_changing_redirected_bytes() {
        let text = "日本語\n\t\x1b]52;c;payload\x07\r\u{009b}2J\u{202e}name\u{2067}end";
        let escaped = terminal_text(text);
        assert!(escaped.starts_with("日本語\n\t"));
        assert!(!escaped.chars().any(|c| (c.is_control() && c != '\n' && c != '\t') || c == '\u{202e}' || c == '\u{2067}'));
        let mut output = vec![];
        emit(&mut output, format_args!("{text}"), false, false, false);
        assert_eq!(output, text.as_bytes());
        output.clear();
        emit(&mut output, format_args!("{text}"), true, true, true);
        assert_eq!(String::from_utf8(output).unwrap(), format!("{}\r\n", escaped.replace('\n', "\r\n")));
    }
    #[test]
    fn serializer_writer_handles_split_unicode_and_redirects() {
        let text = "日本語\u{009b}2J\u{202e}name";
        for tty in [false, true] {
            let mut output = vec![];
            let mut writer = TerminalWriter::new(&mut output, tty);
            for byte in text.as_bytes() { writer.write_all(&[*byte]).unwrap(); }
            writer.flush().unwrap();
            let expected = if tty { terminal_text(text) } else { text.to_string() };
            assert_eq!(output, expected.as_bytes());
        }
    }
}
