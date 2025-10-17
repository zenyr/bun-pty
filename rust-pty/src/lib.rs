//! lib.rs  —  bun-pty backend (final fixed version)

use crossbeam::channel::{unbounded, Receiver, Sender};
use portable_pty::{
    native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize, SlavePty,
};
use serde::{Deserialize, Serialize};
use shell_words::split;                  // <-- NEW
use std::{
    collections::HashMap,
    ffi::CStr,
    io::{Read, Write},
    os::raw::{c_char, c_int},
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

/* ---------- constants ---------- */

const SUCCESS: c_int      = 0;
const ERROR: c_int        = -1;
const CHILD_EXITED: c_int = -2;

/* ---------- helpers ---------- */

fn debug(msg: &str) {
    if std::env::var("BUN_PTY_DEBUG").unwrap_or_default() == "1" {
        eprintln!("[rust-pty] {msg}");
    }
}

/* ---------- command struct ---------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Command {
    cmd: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: String,
}

impl Command {
    fn from_cmdline(cmdline: &str, cwd: &str) -> Self {
        let tokens = split(cmdline).unwrap_or_default();   // shell-accurate split
        if tokens.is_empty() {
            return Self {
                cmd: String::new(),
                args: Vec::new(),
                env: HashMap::new(),
                cwd: cwd.to_owned(),
            };
        }

        let cmd  = tokens[0].clone();
        let args = tokens[1..].to_vec();

        let env = std::env::vars().collect();              // forward everything

        Self { cmd, args, env, cwd: cwd.to_owned() }
    }

    fn to_builder(&self) -> CommandBuilder {
        let mut b = CommandBuilder::new(&self.cmd);
        b.cwd(&self.cwd);
        for a in &self.args {
            b.arg(a);
        }
        for (k, v) in &self.env {
            b.env(k, v);
        }
        b
    }
}

/* ---------- async message channel ---------- */

#[derive(Debug, PartialEq, Eq)]
enum Msg {
    Data(Vec<u8>),
    End,
}

struct Reader {
    rx:   Receiver<Msg>,
    done: AtomicBool,
}
impl Reader {
    fn new(rx: Receiver<Msg>) -> Self {
        Self { rx, done: AtomicBool::new(false) }
    }

    fn read(&self) -> Result<Msg, Box<dyn std::error::Error + Send + Sync>> {
        if self.done.load(Ordering::Relaxed) {
            return Ok(Msg::End);
        }
        let mut msgs: Vec<_> = self.rx.try_iter().collect();
        if msgs.iter().any(|m| matches!(m, Msg::End)) {
            self.done.store(true, Ordering::Relaxed);
            thread::sleep(Duration::from_millis(20));
            msgs.extend(self.rx.try_iter());
            msgs.retain(|m| !matches!(m, Msg::End));
            if msgs.is_empty() { return Ok(Msg::End); }
        }
        if msgs.is_empty() {
            return Ok(Msg::Data(Vec::new()));
        }
        let mut out = Vec::new();
        for m in msgs {
            if let Msg::Data(d) = m { out.extend(d); }
        }
        Ok(Msg::Data(out))
    }
}

/* ---------- Pty wrapper ---------- */

struct Pty {
    reader: Reader,
    tx_w:   Sender<(Vec<u8>, usize)>,      // (buffer, len)
    _slave: Box<dyn SlavePty + Send>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    exited: AtomicBool,
    exit_code: AtomicI32,
    pid:    c_int,
}

unsafe impl Send for Pty {}
unsafe impl Sync for Pty {}

impl Pty {
    fn new(cmd: Command, size: PtySize) -> Result<Arc<Self>, Box<dyn std::error::Error + Send + Sync>> {
        let sys  = native_pty_system();
        let pair = sys.openpty(size)?;
        let mut child = pair.slave.spawn_command(cmd.to_builder())?;
        let killer = Arc::new(Mutex::new(child.clone_killer()));
        let pid    = child.process_id().map(|p| p as c_int).unwrap_or(ERROR);

        /* channels */
        let (tx_r, rx_r)   = unbounded::<Msg>();
        let (tx_w, rx_w)   = unbounded::<(Vec<u8>, usize)>();

        let master = Arc::new(Mutex::new(pair.master));

        let pty = Arc::new(Self {
            reader: Reader::new(rx_r),
            tx_w,
            _slave: pair.slave,
            master: master.clone(),
            killer,
            exited: AtomicBool::new(false),
            exit_code: AtomicI32::new(-1),
            pid,
        });

        /* wait-thread */
        {
            let tx = tx_r.clone();
            let pty_clone = pty.clone();
            thread::spawn(move || {
                let status = child.wait();
                if let Ok(exit_status) = status {
                    let code = exit_status.exit_code() as i32;
                    debug(&format!("exit_status.exit_code(): {}", code));
                    pty_clone.exit_code.store(code, Ordering::Relaxed);
                }
                let _ = tx.send(Msg::End);
            });
        }

        /* read-thread */
        {
            let mut rdr = master.lock().unwrap().try_clone_reader()?;
            let tx = tx_r.clone();
            thread::spawn(move || {
                let mut buf = vec![0; 8192];
                loop {
                    match rdr.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => { let _ = tx.send(Msg::Data(buf[..n].to_vec())); }
                        Err(_) => break,
                    }
                }
                let _ = tx.send(Msg::End);
            });
        }

        /* write-thread  (length-aware) */
        {
            let mut wtr = master.lock().unwrap().take_writer()?;
            thread::spawn(move || {
                while let Ok((data, len)) = rx_w.recv() {
                    if wtr.write_all(&data[..len]).is_err() { break; }
                    let _ = wtr.flush();
                }
            });
        }

        Ok(pty)
    }

    fn read(&self) -> Result<Msg, Box<dyn std::error::Error + Send + Sync>> {
        let m = self.reader.read()?;
        if matches!(m, Msg::End) { self.exited.store(true, Ordering::Relaxed); }
        Ok(m)
    }

    fn write(&self, data: *const u8, len: usize) -> c_int {
        if self.exited.load(Ordering::Relaxed) { return CHILD_EXITED; }
        let slice = unsafe { std::slice::from_raw_parts(data, len) };
        match self.tx_w.send((slice.to_vec(), len)) {
            Ok(_)  => SUCCESS,
            Err(_) => ERROR,
        }
    }

    fn resize(&self, size: PtySize) -> c_int {
        if self.exited.load(Ordering::Relaxed) { return CHILD_EXITED; }
        self.master.lock().unwrap().resize(size).map(|_| SUCCESS).unwrap_or(ERROR)
    }
    fn kill(&self) -> c_int {
        let res = self.killer.lock().map(|mut k| k.kill());
        match res {
            Ok(Ok(_)) => { self.exited.store(true, Ordering::Relaxed); SUCCESS }
            _         => ERROR,
        }
    }
}

/* ---------- registry ---------- */

use std::sync::atomic::AtomicU32;
lazy_static::lazy_static! {
    static ref REG: Mutex<HashMap<u32, Arc<Pty>>> = Mutex::new(HashMap::new());
}
static NEXT: AtomicU32 = AtomicU32::new(1);

fn store(pty: Arc<Pty>) -> u32 {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    REG.lock().unwrap().insert(id, pty);
    id
}
fn with<F: FnOnce(&Arc<Pty>) -> c_int>(id: u32, f: F) -> c_int {
    REG.lock().unwrap().get(&id).map(f).unwrap_or(ERROR)
}

/* ---------- FFI ---------- */

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bun_pty_spawn(
    cmd:  *const c_char,
    cwd:  *const c_char,
    cols: c_int,
    rows: c_int,
) -> c_int {
    if cmd.is_null() || cwd.is_null() || cols <= 0 || rows <= 0 { return ERROR; }

    let cmdline = unsafe { CStr::from_ptr(cmd) }.to_string_lossy();
    let cwd     = unsafe { CStr::from_ptr(cwd) }.to_string_lossy();

    let size = PtySize { cols: cols as u16, rows: rows as u16, pixel_width: 0, pixel_height: 0 };
    match Pty::new(Command::from_cmdline(&cmdline, &cwd), size) {
        Ok(p)  => store(p) as c_int,
        Err(e) => { debug(&format!("spawn error: {e}")); ERROR },
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bun_pty_write(
    handle: c_int,
    data:   *const u8,
    len:    c_int,
) -> c_int {
    if handle <= 0 || data.is_null() || len < 0 { return ERROR; }
    with(handle as u32, |p| p.write(data, len as usize))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bun_pty_read(
    handle: c_int,
    buf:    *mut u8,
    len:    c_int,
) -> c_int {
    if handle <= 0 || buf.is_null() || len <= 0 { return ERROR; }
    with(handle as u32, |pty| match pty.read() {
        Ok(Msg::Data(d)) if !d.is_empty() => {
            let n = d.len().min(len as usize);
            unsafe { std::ptr::copy_nonoverlapping(d.as_ptr(), buf, n); }
            n as c_int
        }
        Ok(Msg::End) => CHILD_EXITED,
        _            => 0,                         // no data
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_resize(handle: c_int, cols: c_int, rows: c_int) -> c_int {
    if handle <= 0 || cols <= 0 || rows <= 0 { return ERROR; }
    with(handle as u32, |p| {
        p.resize(PtySize { cols: cols as u16, rows: rows as u16, pixel_width: 0, pixel_height: 0 })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_kill(handle: c_int) -> c_int {
    if handle <= 0 { return ERROR; }
    with(handle as u32, |p| p.kill())
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_get_pid(handle: c_int) -> c_int {
    if handle <= 0 { return ERROR; }
    with(handle as u32, |p| p.pid)
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_get_exit_code(handle: c_int) -> c_int {
    if handle <= 0 { return ERROR; }
    with(handle as u32, |p| p.exit_code.load(Ordering::Relaxed))
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_close(handle: c_int) {
    if handle <= 0 { return; }
    REG.lock().unwrap().remove(&(handle as u32));
}