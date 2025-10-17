import { expect, test, afterEach } from "bun:test";
import { Terminal } from "./terminal";
import type { IExitEvent } from "./interfaces";

// This is an integration test file that runs tests against the actual Rust backend.
// Only run if the environment variable RUN_INTEGRATION_TESTS is set to "true"
const runIntegrationTests = process.env.RUN_INTEGRATION_TESTS === "true";

// Skip tests if integration tests are not enabled
if (!runIntegrationTests) {
  test.skip("Integration tests", () => {
    console.log("Skipping integration tests. Set RUN_INTEGRATION_TESTS=true to run them.");
  });
  process.exit(0);
}

// Keep track of terminals created so they can be cleaned up
const terminals: Terminal[] = [];

afterEach(() => {
  // Clean up any terminals created during tests
  for (const term of terminals) {
    try {
      term.kill();
    } catch (e) {
      // Ignore errors during cleanup
    }
  }
  terminals.length = 0;
});

test("Terminal can spawn a real process", () => {
  const terminal = new Terminal("sleep", ["1"]);
  terminals.push(terminal);
  
  expect(terminal.pid).toBeGreaterThan(0);
});

test("Terminal can receive data from a real process", async () => {
  // Use a script command that will definitely produce output - use single argument for '-c' option
  const terminal = new Terminal("bash", ["-c", "echo 'Hello from Bun PTY'"]);
  terminals.push(terminal);
  
  // Collect output and track when process exits
  let dataReceived = "";
  let hasExited = false;
  
  terminal.onData((data) => {
    console.log("[TEST] Received data:", data);
    dataReceived += data;
  });
  
  terminal.onExit(() => {
    console.log("[TEST] Process exited");
    hasExited = true;
  });
  
  // Wait for data and process exit
  const timeout = 2000; // 2 second timeout
  const start = Date.now();
  
  while (!hasExited && Date.now() - start < timeout) {
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Allow a short delay for any buffered output to be processed
  await new Promise(resolve => setTimeout(resolve, 100));
  
  expect(dataReceived).toContain("Hello from Bun PTY");
});

test("Terminal can send data to a real process", async () => {
  let dataReceived = "";
  let hasExited = false;
  
  // Use a properly quoted bash command
  const terminal = new Terminal("bash", ["-c", "read line; echo \"You typed: $line\""]);
  terminals.push(terminal);
  
  terminal.onData((data) => {
    console.log("[TEST] Received data:", data);
    dataReceived += data;
  });
  
  terminal.onExit(() => {
    console.log("[TEST] Process exited");
    hasExited = true;
  });
  
  // Give the process time to start up
  await new Promise(resolve => setTimeout(resolve, 100));
  
  console.log("[TEST] Sending input: Hello from Bun PTY");
  terminal.write("Hello from Bun PTY\n");
  
  // Wait for process to exit or timeout
  const timeout = 2000; // 2 second timeout
  const start = Date.now();
  
  while (!hasExited && Date.now() - start < timeout) {
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Allow a short delay for any buffered output to be processed
  await new Promise(resolve => setTimeout(resolve, 100));
  
  expect(dataReceived).toContain("You typed: Hello from Bun PTY");
});

test("Terminal can resize a real terminal", async () => {
  const terminal = new Terminal("sleep", ["1"]);
  terminals.push(terminal);
  
  // Should not throw
  terminal.resize(100, 40);
  
  expect(terminal.cols).toBe(100);
  expect(terminal.rows).toBe(40);
  
  // Wait for process to exit
  await new Promise(resolve => setTimeout(resolve, 1200));
});

test("Terminal can kill a real process", async () => {
  const terminal = new Terminal("sleep", ["10"]);
  terminals.push(terminal);
  
  let exitEvent: IExitEvent | null = null;
  terminal.onExit((event) => {
    console.log("[TEST] Process exited with event:", event);
    exitEvent = event;
  });
  
  // Kill the process
  terminal.kill();
  
  // Wait for exit event
  const timeout = 2000; // 2 second timeout
  const start = Date.now();
  
  while (!exitEvent && Date.now() - start < timeout) {
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  expect(exitEvent).not.toBeNull();
});

test("Terminal can retrieve the correct process ID", () => {
  // Create a terminal with sleep command (long-running so we can check PID)
  const terminal = new Terminal("sleep", ["5"]);
  terminals.push(terminal);
  
  // Check that we got a valid PID
  const pid = terminal.pid;
  console.log("[TEST] Process ID:", pid);
  expect(pid).toBeGreaterThan(0);
  
  // Verify this PID actually exists in the system
  // This is platform-specific, but we can use a simple check
  let pidExists = false;
  
  try {
    // On Unix systems, sending signal 0 checks if process exists without affecting it
    process.kill(pid, 0);
    pidExists = true;
    console.log("[TEST] Process ID exists in system");
  } catch (error) {
    console.error("[TEST] Error checking process:", error);
  }
  
  expect(pidExists).toBe(true);
  
  // Kill the process to clean up
  terminal.kill();
});

test("Terminal can run a bash script", async () => {
  let dataReceived = "";
  let hasExited = false;
  
  // Use a properly quoted bash command
  const terminal = new Terminal("bash", ["-c", "echo 'Hello' && sleep 0.2 && echo 'World'"]);
  terminals.push(terminal);
  
  terminal.onData((data) => {
    console.log("[TEST] Received data:", data);
    dataReceived += data;
  });
  
  terminal.onExit(() => {
    console.log("[TEST] Process exited");
    hasExited = true;
  });
  
  // Wait for process to exit or timeout
  const timeout = 2000; // 2 second timeout
  const start = Date.now();
  
  while (!hasExited && Date.now() - start < timeout) {
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  // Allow a short delay for any buffered output to be processed
  await new Promise(resolve => setTimeout(resolve, 100));
  
  expect(dataReceived).toContain("Hello");
  expect(dataReceived).toContain("World");
});

test("Terminal can detect non-zero exit codes", async () => {
  let exitEvent: IExitEvent | null = null;
  
  // Run a command that exits with code 1
  const terminal = new Terminal("false", []);
  terminals.push(terminal);
  
  terminal.onExit((event) => {
    console.log("[TEST] Process exited with event:", event);
    exitEvent = event;
  });
  
  // Wait for exit event
  const timeout = 2000; // 2 second timeout
  const start = Date.now();
  
  while (!exitEvent && Date.now() - start < timeout) {
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  expect(exitEvent).not.toBeNull();
  if (exitEvent) {
    expect(exitEvent.exitCode).not.toBe(0); // false exits with 1
  }
});
