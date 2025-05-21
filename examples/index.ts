/**
 * Example showing how to use bun-pty with TypeScript
 */
import { spawn } from 'bun-pty';
import type { IPty, IExitEvent } from 'bun-pty';

// Type-safe options
interface TerminalOptions {
  shell: string;
  args?: string[];
  cwd?: string;
  termName?: string;
}

/**
 * Creates a terminal with the given options
 */
function createTypedTerminal(options: TerminalOptions): IPty {
  const {
    shell,
    args = [],
    cwd = process.cwd(),
    termName = 'xterm-256color'
  } = options;
  
  return spawn(shell, args, {
    name: termName,
    cwd,
    cols: 100,
    rows: 30
  });
}

// Usage example with full type safety
async function main() {
  // Create a terminal running bash
  const terminal = createTypedTerminal({
    shell: 'bash',
    termName: 'xterm-256color'
  });
  
  console.log(`Terminal created with PID: ${terminal.pid}`);
  console.log(`Terminal size: ${terminal.cols}x${terminal.rows}`);
  
  // Add event listeners
  const dataHandler = terminal.onData((data: string) => {
    process.stdout.write(data);
  });
  
  const exitHandler = terminal.onExit((event: IExitEvent) => {
    console.log(`Terminal exited with code: ${event.exitCode}`);
    process.exit(0);
  });
  
  // Write some commands
  terminal.write('echo "Hello from TypeScript with bun-pty"\n');
  
  // Resize the terminal
  terminal.resize(120, 40);
  
  // Exit after 5 seconds
  setTimeout(() => {
    console.log('Sending exit command...');
    terminal.write('exit\n');
    
    // Clean up event handlers
    dataHandler.dispose();
    exitHandler.dispose();
  }, 5000);
}

// Run the example
if (import.meta.main) {
  main().catch(console.error);
} 