use crossbeam::channel::{Receiver, Sender, unbounded};
use portable_pty::{
    ChildKiller, CommandBuilder, MasterPty, PtySize, SlavePty, native_pty_system,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::{CStr, CString},
    io::Read,
    os::raw::{c_char, c_int},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    thread,
    time::Duration,
};

// Constants for return codes
const SUCCESS: c_int = 0;
const ERROR: c_int = -1;
const CHILD_EXITED: c_int = -2;

// Debug print function that only prints when BUN_PTY_DEBUG=1
fn debug_print(msg: &str) {
    if std::env::var("BUN_PTY_DEBUG").unwrap_or_default() == "1" {
        eprintln!("[rust-pty] {}", msg);
    }
}

// Convert a Box<dyn Error> to a CString for FFI
fn error_to_cstring(err: Box<dyn std::error::Error>) -> CString {
    CString::new(err.to_string()).unwrap_or_else(|_| CString::new("Unknown error").unwrap())
}

// Command representation for spawning processes
#[derive(Serialize, Deserialize, Debug, Clone)]
struct Command {
    cmd: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: String,
}

impl Command {
    // Create a Command from a command line string and cwd
    fn from_command_line(cmd_line: &str, cwd: &str) -> Self {
        let tokens = tokenize_command(cmd_line);
        if tokens.is_empty() {
            return Self {
                cmd: String::new(),
                args: Vec::new(),
                env: HashMap::new(),
                cwd: cwd.to_string(),
            };
        }

        // Process tokens for special shell commands
        let (cmd, args) = process_command(&tokens);
        
        // Create default environment
        let mut env = HashMap::new();
        // Always preserve PATH
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        
        // Preserve common terminal environment variables
        for (key, value) in std::env::vars() {
            if key.starts_with("TERM") || key == "USER" || key == "HOME" || key == "SHELL" {
                env.insert(key, value);
            }
        }

        Self {
            cmd,
            args,
            env,
            cwd: cwd.to_string(),
        }
    }

    // Convert to CommandBuilder for portable-pty
    fn to_command_builder(&self) -> CommandBuilder {
        let mut builder = CommandBuilder::new(&self.cmd);
        
        // Add arguments
        for arg in &self.args {
            builder.arg(arg);
        }
        
        // Set working directory
        builder.cwd(&self.cwd);
        
        // Add environment variables
        for (key, value) in &self.env {
            builder.env(key, value);
        }
        
        builder
    }
}

// Message type for PTY I/O
#[derive(Debug, PartialEq, Eq)]
enum Message {
    Data(Vec<u8>),
    End,
}

// PTY reader for non-blocking reads
struct PtyReader {
    rx: Receiver<Message>,
    done: AtomicBool,
}

// Manually implement Clone since AtomicBool doesn't implement it
impl Clone for PtyReader {
    fn clone(&self) -> Self {
        Self {
            rx: self.rx.clone(),
            done: AtomicBool::new(self.done.load(Ordering::Relaxed)),
        }
    }
}

impl PtyReader {
    fn new(rx: Receiver<Message>) -> Self {
        Self {
            rx,
            done: AtomicBool::new(false),
        }
    }
    
    // Non-blocking read from the PTY
    fn read(&self) -> Result<Message, Box<dyn std::error::Error + Send + Sync>> {
        // If we've seen End message before, just return End
        if self.done.load(Ordering::Relaxed) {
            return Ok(Message::End);
        }

        // Collect any pending messages
        let mut msgs: Vec<_> = self.rx.try_iter().collect();
        
        // Check for End message
        if msgs.iter().any(|msg| matches!(msg, Message::End)) {
            self.done.store(true, Ordering::Relaxed);
            
            // Wait a bit for any final data
            thread::sleep(Duration::from_millis(50));
            msgs.extend(self.rx.try_iter());
            
            // Filter out End messages for now
            msgs.retain(|msg| !matches!(msg, Message::End));
            
            if msgs.is_empty() {
                return Ok(Message::End);
            }
        }
        
        // If we have no messages and no End, return empty Data
        if msgs.is_empty() {
            return Ok(Message::Data(Vec::new()));
        }
        
        // Combine all data messages into a single buffer
        let mut combined_data = Vec::new();
        for msg in msgs {
            if let Message::Data(data) = msg {
                combined_data.extend(data);
            }
        }
        
        Ok(Message::Data(combined_data))
    }
}

// Main PTY structure
struct Pty {
    reader: PtyReader,
    tx_write: Sender<Vec<u8>>,
    // Keep the slave alive
    _slave: Box<dyn SlavePty + Send>,
    master: Box<dyn MasterPty + Send>,
    child_killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    child_exited: AtomicBool,
    pid: c_int,
}

// Add Send + Sync to make thread-safe
unsafe impl Send for Pty {}
unsafe impl Sync for Pty {}

impl Pty {
    // Create a new PTY with the given command and size
    fn create(command: Command, size: PtySize) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let pty_system = native_pty_system();
        
        // Open the PTY with the specified size
        let pair = pty_system.openpty(size)?;
        debug_print(&format!("PTY opened with size: {}x{}", size.cols, size.rows));
        
        // Convert Command to CommandBuilder
        let cmd_builder = command.to_command_builder();
        debug_print(&format!("Command: {} {:?}", command.cmd, command.args));
        
        // Spawn the command in the PTY
        let mut child = pair.slave.spawn_command(cmd_builder)?;
        
        // Create the child killer (clone_killer returns Box<dyn ChildKiller>, not Result)
        let child_killer = Arc::new(Mutex::new(child.clone_killer()));
        
        // Try to get the child PID if available
        let pid = child.process_id().map(|pid| pid as c_int).unwrap_or(ERROR);
        debug_print(&format!("Spawned child with PID: {}", pid));
        
        // Create channels for reading and writing
        let (tx_read, rx_read) = unbounded::<Message>();
        let (tx_write, rx_write) = unbounded::<Vec<u8>>();
        
        // Clone for child exit thread
        let tx_read_exit = tx_read.clone();
        
        // Thread to monitor child exit
        thread::spawn(move || {
            let wait_result = child.wait();
            match wait_result {
                Ok(status) => debug_print(&format!("Child process exited with status: {:?}", status)),
                Err(e) => debug_print(&format!("Error waiting for child: {}", e)),
            }
            // Send End message
            let _ = tx_read_exit.send(Message::End);
        });
        
        // Thread for reading from the PTY
        let mut reader = pair.master.try_clone_reader()?;
        let tx_read_clone = tx_read.clone();
        thread::spawn(move || {
            let mut buf = vec![0u8; 8 * 1024]; // 8KB buffer
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        // Send the read data
                        if tx_read_clone.send(Message::Data(buf[..n].to_vec())).is_err() {
                            break; // Receiver disconnected
                        }
                    },
                    Err(e) => {
                        debug_print(&format!("Error reading from PTY: {}", e));
                        break;
                    }
                }
            }
            // Make sure End is sent
            let _ = tx_read_clone.send(Message::End);
        });
        
        // Thread for writing to the PTY
        let mut writer = pair.master.take_writer()?;
        thread::spawn(move || {
            while let Ok(data) = rx_write.recv() {
                if writer.write_all(&data).is_err() {
                    debug_print("Error writing to PTY");
                    break;
                }
                if writer.flush().is_err() {
                    debug_print("Error flushing PTY writer");
                    break;
                }
            }
        });
        
        Ok(Self {
            reader: PtyReader::new(rx_read),
            tx_write,
            _slave: pair.slave,
            master: pair.master,
            child_killer,
            child_exited: AtomicBool::new(false),
            pid,
        })
    }
    
    // Read from the PTY
    fn read(&self) -> Result<Message, Box<dyn std::error::Error + Send + Sync>> {
        let msg = self.reader.read()?;
        if matches!(msg, Message::End) {
            self.child_exited.store(true, Ordering::Relaxed);
        }
        Ok(msg)
    }
    
    // Write to the PTY
    fn write(&self, data: &[u8]) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.child_exited.load(Ordering::Relaxed) {
            return Err("Child process has exited".into());
        }
        
        self.tx_write.send(data.to_vec())?;
        Ok(())
    }
    
    // Resize the PTY
    fn resize(&self, size: PtySize) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.child_exited.load(Ordering::Relaxed) {
            return Err("Child process has exited".into());
        }
        
        self.master.resize(size)?;
        Ok(())
    }
    
    // Kill the child process
    fn kill(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.child_exited.load(Ordering::Relaxed) {
            return Ok(());
        }
        
        if let Ok(mut killer) = self.child_killer.lock() {
            killer.kill()?;
            self.child_exited.store(true, Ordering::Relaxed);
            Ok(())
        } else {
            Err("Failed to lock child_killer mutex".into())
        }
    }
    
    // Get the current PTY size
    fn get_size(&self) -> Result<PtySize, Box<dyn std::error::Error + Send + Sync>> {
        self.master.get_size().map_err(Into::into)
    }
}

// Store PTY handles in a global registry (for FFI simplicity)
lazy_static::lazy_static! {
    static ref PTY_REGISTRY: Mutex<Vec<Option<Arc<Pty>>>> = Mutex::new(Vec::new());
}

// Simplified shell-like tokenizer that respects quotes
fn tokenize_command(cmd: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current_token = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut escaped = false;
    
    for c in cmd.chars() {
        if escaped {
            current_token.push(c);
            escaped = false;
            continue;
        }
        
        match c {
            '\\' => {
                escaped = true;
                current_token.push(c);
            },
            ' ' if !in_single_quote && !in_double_quote => {
                if !current_token.is_empty() {
                    tokens.push(current_token);
                    current_token = String::new();
                }
            },
            '\'' if !in_double_quote => {
                in_single_quote = !in_single_quote;
                current_token.push(c);
            },
            '"' if !in_single_quote => {
                in_double_quote = !in_double_quote;
                current_token.push(c);
            },
            _ => {
                current_token.push(c);
            }
        }
    }
    
    if !current_token.is_empty() {
        tokens.push(current_token);
    }
    
    tokens
}

// Process tokens for special shell commands
fn process_command(tokens: &[String]) -> (String, Vec<String>) {
    if tokens.is_empty() {
        return (String::new(), Vec::new());
    }
    
    // Check for common shell command patterns
    if tokens.len() >= 3 {
        let cmd = &tokens[0];
        let first_arg = &tokens[1];
        
        // Handle bash -c, sh -c, zsh -c, etc.
        if (cmd == "bash" || cmd == "sh" || cmd == "zsh") && first_arg == "-c" {
            // For shell -c, use shell as the executable and combine the rest properly
            let command = tokens[0].clone();
            let script = tokens[2..].join(" ");
            let args = vec!["-c".to_string(), script];
            return (command, args);
        }
    }
    
    // Default case: split normally
    let command = tokens[0].clone();
    let args = tokens[1..].iter().cloned().collect();
    (command, args)
}

// FFI Functions

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_spawn(
    command: *const c_char, 
    cwd: *const c_char,
    cols: c_int,
    rows: c_int
) -> c_int {
    // Validate parameters
    if command.is_null() {
        debug_print("Command pointer is null");
        return ERROR;
    }
    if cwd.is_null() {
        debug_print("CWD pointer is null");
        return ERROR;
    }
    
    // Check size values
    if cols <= 0 || rows <= 0 {
        debug_print(&format!("Invalid dimensions: cols={}, rows={}", cols, rows));
        return ERROR;
    }
    
    // Convert C strings to Rust strings
    let cmd_str = match unsafe { CStr::from_ptr(command).to_str() } {
        Ok(s) => s,
        Err(e) => {
            debug_print(&format!("Failed to convert command string: {}", e));
            return ERROR;
        }
    };
    
    let cwd_str = match unsafe { CStr::from_ptr(cwd).to_str() } {
        Ok(s) => s,
        Err(e) => {
            debug_print(&format!("Failed to convert cwd string: {}", e));
            return ERROR;
        }
    };
    
    // Create Command object from the command line
    let cmd = Command::from_command_line(cmd_str, cwd_str);
    
    // Create PtySize
    let size = PtySize {
        rows: rows as u16,
        cols: cols as u16,
        pixel_width: 0,
        pixel_height: 0,
    };
    
    // Create the PTY
    match Pty::create(cmd, size) {
        Ok(pty) => {
            // Store in registry
            let pty = Arc::new(pty);
            
            match PTY_REGISTRY.lock() {
                Ok(mut reg) => {
                    reg.push(Some(pty));
                    let handle = (reg.len() - 1) as c_int;
                    debug_print(&format!("PTY created with handle: {}", handle));
                    handle
                },
                Err(e) => {
                    debug_print(&format!("Failed to lock registry: {}", e));
                    ERROR
                }
            }
        },
        Err(e) => {
            debug_print(&format!("Failed to create PTY: {}", e));
            ERROR
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_write(handle: c_int, data: *const c_char) -> c_int {
    // Validate handle
    if handle < 0 {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        return ERROR;
    }
    
    // Check null pointer
    if data.is_null() {
        debug_print("Data pointer is null");
        return ERROR;
    }
    
    // Get the data to write
    let data_bytes = match unsafe { CStr::from_ptr(data) }.to_bytes() {
        bytes => bytes,
    };
    
    // Get the registry lock
    let reg = match PTY_REGISTRY.lock() {
        Ok(reg) => reg,
        Err(e) => {
            debug_print(&format!("Failed to lock registry: {}", e));
            return ERROR;
        }
    };
    
    // Look up the PTY by handle
    if let Some(Some(pty)) = reg.get(handle as usize) {
        // Check if the child process has exited
        if pty.child_exited.load(Ordering::Relaxed) {
            debug_print("Cannot write to exited child process");
            return CHILD_EXITED;
        }
        
        // Write to the PTY
        match pty.write(data_bytes) {
            Ok(_) => SUCCESS,
            Err(e) => {
                debug_print(&format!("Failed to write to PTY: {}", e));
                if pty.child_exited.load(Ordering::Relaxed) {
                    CHILD_EXITED
                } else {
                    ERROR
                }
            }
        }
    } else {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        ERROR
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_read(handle: c_int, buf: *mut c_char, buf_len: c_int) -> c_int {
    // Validate parameters
    if handle < 0 {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        return ERROR;
    }
    
    if buf.is_null() || buf_len <= 0 {
        debug_print("Invalid buffer parameters");
        return ERROR;
    }
    
    // Get the registry lock
    let reg = match PTY_REGISTRY.lock() {
        Ok(reg) => reg,
        Err(e) => {
            debug_print(&format!("Failed to lock registry: {}", e));
            return ERROR;
        }
    };
    
    // Look up the PTY by handle
    if let Some(Some(pty)) = reg.get(handle as usize) {
        // Try to read from the PTY
        match pty.read() {
            Ok(Message::Data(data)) => {
                if data.is_empty() {
                    // No data available now
                    return 0;
                }
                
                // Copy data to the output buffer (up to buf_len)
                let copy_len = std::cmp::min(data.len(), buf_len as usize);
                unsafe {
                    std::ptr::copy_nonoverlapping(data.as_ptr(), buf as *mut u8, copy_len);
                }
                copy_len as c_int
            },
            Ok(Message::End) => {
                debug_print("Child process has exited");
                CHILD_EXITED
            },
            Err(e) => {
                debug_print(&format!("Failed to read from PTY: {}", e));
                if pty.child_exited.load(Ordering::Relaxed) {
                    CHILD_EXITED
                } else {
                    ERROR
                }
            }
        }
    } else {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        ERROR
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_resize(handle: c_int, cols: c_int, rows: c_int) -> c_int {
    // Validate parameters
    if handle < 0 {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        return ERROR;
    }
    
    if cols <= 0 || rows <= 0 {
        debug_print(&format!("Invalid dimensions: cols={}, rows={}", cols, rows));
        return ERROR;
    }
    
    // Get the registry lock
    let reg = match PTY_REGISTRY.lock() {
        Ok(reg) => reg,
        Err(e) => {
            debug_print(&format!("Failed to lock registry: {}", e));
            return ERROR;
        }
    };
    
    // Look up the PTY by handle
    if let Some(Some(pty)) = reg.get(handle as usize) {
        // Check if the child process has exited
        if pty.child_exited.load(Ordering::Relaxed) {
            debug_print("Cannot resize: child process has exited");
            return CHILD_EXITED;
        }
        
        // Create the new size
        let size = PtySize {
            rows: rows as u16,
            cols: cols as u16,
            pixel_width: 0,
            pixel_height: 0,
        };
        
        // Resize the PTY
        match pty.resize(size) {
            Ok(_) => {
                debug_print(&format!("PTY resized to cols={}, rows={}", cols, rows));
                SUCCESS
            },
            Err(e) => {
                debug_print(&format!("Failed to resize PTY: {}", e));
                if pty.child_exited.load(Ordering::Relaxed) {
                    CHILD_EXITED
                } else {
                    ERROR
                }
            }
        }
    } else {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        ERROR
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_kill(handle: c_int) -> c_int {
    // Validate handle
    if handle < 0 {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        return ERROR;
    }
    
    // Get the registry lock
    let reg = match PTY_REGISTRY.lock() {
        Ok(reg) => reg,
        Err(e) => {
            debug_print(&format!("Failed to lock registry: {}", e));
            return ERROR;
        }
    };
    
    // Look up the PTY by handle
    if let Some(Some(pty)) = reg.get(handle as usize) {
        // Check if the child process has already exited
        if pty.child_exited.load(Ordering::Relaxed) {
            debug_print("Child process has already exited");
            return SUCCESS; // Already dead, so consider this a success
        }
        
        // Kill the child process
        match pty.kill() {
            Ok(_) => {
                debug_print("Child process killed successfully");
                SUCCESS
            },
            Err(e) => {
                debug_print(&format!("Failed to kill child process: {}", e));
                ERROR
            }
        }
    } else {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        ERROR
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_get_pid(handle: c_int) -> c_int {
    // Validate handle
    if handle < 0 {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        return ERROR;
    }
    
    // Get the registry lock
    let reg = match PTY_REGISTRY.lock() {
        Ok(reg) => reg,
        Err(e) => {
            debug_print(&format!("Failed to lock registry: {}", e));
            return ERROR;
        }
    };
    
    // Look up the PTY by handle
    if let Some(Some(pty)) = reg.get(handle as usize) {
        // Return the stored PID
        pty.pid
    } else {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        ERROR
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn bun_pty_close(handle: c_int) -> c_int {
    debug_print(&format!("Closing PTY handle: {}", handle));
    
    // Validate handle
    if handle < 0 {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        return ERROR;
    }
    
    // Get the registry lock for writing
    let mut reg = match PTY_REGISTRY.lock() {
        Ok(reg) => reg,
        Err(e) => {
            debug_print(&format!("Failed to lock registry: {}", e));
            return ERROR;
        }
    };
    
    // Check if the handle is valid
    if handle as usize >= reg.len() {
        debug_print(&format!("Invalid PTY handle: {}", handle));
        return ERROR;
    }
    
    // Try to kill the process if it's still running
    if let Some(Some(pty)) = reg.get(handle as usize) {
        if !pty.child_exited.load(Ordering::Relaxed) {
            debug_print("Killing child process during close");
            let _ = pty.kill();
        }
    }
    
    // Remove the PTY from the registry
    // This will drop all references and clean up resources when the last Arc is dropped
    reg[handle as usize] = None;
    
    debug_print(&format!("PTY handle {} closed successfully", handle));
    SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tokenize_command() {
        let cmd = "bash -c 'echo \"hello world\"'";
        let tokens = tokenize_command(cmd);
        assert_eq!(tokens, vec!["bash", "-c", "'echo \"hello world\"'"]);
        
        let cmd = "ls -la /tmp";
        let tokens = tokenize_command(cmd);
        assert_eq!(tokens, vec!["ls", "-la", "/tmp"]);
    }
    
    #[test]
    fn test_process_command() {
        let tokens = vec!["bash".to_string(), "-c".to_string(), "echo".to_string(), "hello".to_string()];
        let (cmd, args) = process_command(&tokens);
        assert_eq!(cmd, "bash");
        assert_eq!(args, vec!["-c".to_string(), "echo hello".to_string()]);
        
        let tokens = vec!["ls".to_string(), "-la".to_string(), "/tmp".to_string()];
        let (cmd, args) = process_command(&tokens);
        assert_eq!(cmd, "ls");
        assert_eq!(args, vec!["-la".to_string(), "/tmp".to_string()]);
    }
    
    #[test]
    fn test_command_from_command_line() {
        let cmd = Command::from_command_line("bash -c 'echo hello'", "/tmp");
        assert_eq!(cmd.cmd, "bash");
        assert_eq!(cmd.args, vec!["-c".to_string(), "echo hello".to_string()]);
        assert_eq!(cmd.cwd, "/tmp");
        assert!(cmd.env.contains_key("PATH"));
    }
}
