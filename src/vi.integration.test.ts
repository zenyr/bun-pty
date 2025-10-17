import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Terminal } from "./terminal";

describe("Vi Editor Integration Tests", () => {
  // Helper to create isolated terminal for each test
  const createTestTerminal = (): {
    terminal: Terminal;
    outputBuffer: string[];
    waitForPrompt: () => Promise<void>;
    testDir: string;
    testFile: string;
    cleanup: () => void;
  } => {
    const testDir = join(
      process.cwd(),
      ".temp",
      `test-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
    );
    const testFile = join(testDir, "test.txt");
    const outputBuffer: string[] = [];

    // Create test directory
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }

    // Remove test file if exists
    if (existsSync(testFile)) {
      rmSync(testFile);
    }

    // Start bash in test directory
    const terminal = new Terminal("bash", [], {
      name: "xterm",
      cwd: testDir,
      cols: 80,
      rows: 24,
    });

    terminal.onData((data: string) => {
      outputBuffer.push(data);
    });

    terminal.onExit(() => {
      // Terminal exit handled
    });

    const waitForPrompt = (): Promise<void> => {
      return new Promise((resolve) => {
        const checkPrompt = () => {
          const output = outputBuffer.join("");
          if (output.includes("$ ") || output.includes("# ")) {
            resolve();
          } else {
            setTimeout(checkPrompt, 100);
          }
        };
        setTimeout(checkPrompt, 500);
      });
    };

    const cleanup = (): void => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    };

    return {
      terminal,
      outputBuffer,
      waitForPrompt,
      testDir,
      testFile,
      cleanup,
    };
  };

  const waitForOutput = (
    outputBuffer: string[],
    pattern: string | RegExp,
    timeout = 10000
  ): Promise<string> => {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const startTime = Date.now();

    const checkOutput = () => {
      const output = outputBuffer.join("");

      if (typeof pattern === "string" && output.includes(pattern)) {
        resolve(output);
      } else if (pattern instanceof RegExp && pattern.test(output)) {
        resolve(output);
      } else if (Date.now() - startTime > timeout) {
        reject(new Error(`Timeout waiting for pattern: ${pattern}`));
      } else {
        setTimeout(checkOutput, 100);
      }
    };

    checkOutput();
    return promise;
  };

  const sendCommand = async (
    terminal: Terminal,
    outputBuffer: string[],
    command: string,
    waitForPattern?: string | RegExp,
    delay = 200
  ): Promise<string> => {
    terminal.write(command);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (waitForPattern) {
      return await waitForOutput(outputBuffer, waitForPattern);
    }
    return outputBuffer.join("");
  };

  // Helper functions to reduce duplication
  const startVi = async (
    terminal: Terminal,
    outputBuffer: string[],
    fileName = "test.txt"
  ): Promise<void> => {
    await sendCommand(terminal, outputBuffer, `vi ${fileName}\n`);
    await waitForOutput(outputBuffer, /~/);
  };

  const enterInsertMode = async (
    terminal: Terminal,
    outputBuffer: string[]
  ): Promise<void> => {
    await sendCommand(terminal, outputBuffer, "i");
    await waitForOutput(outputBuffer, "-- INSERT --");
  };

  const typeText = async (
    terminal: Terminal,
    outputBuffer: string[],
    text: string
  ): Promise<void> => {
    await sendCommand(terminal, outputBuffer, text);
  };

  const exitInsertMode = async (
    terminal: Terminal,
    outputBuffer: string[]
  ): Promise<void> => {
    await sendCommand(terminal, outputBuffer, "\x1b"); // ESC
    await new Promise((resolve) => setTimeout(resolve, 100)); // Reduced wait time for mode change
  };

  const saveAndQuit = async (
    terminal: Terminal,
    outputBuffer: string[]
  ): Promise<void> => {
    await sendCommand(terminal, outputBuffer, ":wq\n");
    await waitForOutput(outputBuffer, "$ ");
  };

  const saveWithoutQuit = async (
    terminal: Terminal,
    outputBuffer: string[]
  ): Promise<void> => {
    await sendCommand(terminal, outputBuffer, ":w\n");
    await waitForOutput(outputBuffer, '"test.txt"');
  };

  const quitWithoutSaving = async (
    terminal: Terminal,
    outputBuffer: string[]
  ): Promise<void> => {
    await sendCommand(terminal, outputBuffer, ":q!\n");
    await waitForOutput(outputBuffer, "$ ");
  };

  const verifyFileContent = (testFile: string, expected: string): void => {
    expect(existsSync(testFile)).toBe(true);
    const content = readFileSync(testFile, "utf8");
    expect(content).toBe(expected);
  };

  it("should start vi editor successfully", async () => {
    const { terminal, outputBuffer, waitForPrompt, testFile, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    await startVi(terminal, outputBuffer);

    // Wait for vi to start (should see empty buffer or ~ lines)
    const output = outputBuffer.join("");

    expect(output).toContain("~"); // Empty lines in vi
    expect(output).toMatch(/"test\.txt" \[New\]/); // New file message

    terminal.kill();
    cleanup();
  });

  it("should enter insert mode and type text", async () => {
    const { terminal, outputBuffer, waitForPrompt, testFile, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    await startVi(terminal, outputBuffer);
    await enterInsertMode(terminal, outputBuffer);

    // Type some text
    await typeText(terminal, outputBuffer, "Hello, this is a test file!\n");
    await typeText(terminal, outputBuffer, "Second line of text.\n");

    await exitInsertMode(terminal, outputBuffer);
    await saveAndQuit(terminal, outputBuffer);

    // Wait a bit for file write to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify file contents
    verifyFileContent(
      testFile,
      "Hello, this is a test file!\nSecond line of text.\n\n"
    );

    terminal.kill();
    cleanup();
  });

  it("should handle multiple lines editing", async () => {
    const { terminal, outputBuffer, waitForPrompt, testFile, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    await startVi(terminal, outputBuffer);
    await enterInsertMode(terminal, outputBuffer);

    // Type multiple lines
    const lines = ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];

    for (const line of lines) {
      await typeText(terminal, outputBuffer, line + "\n");
    }

    await exitInsertMode(terminal, outputBuffer);
    await saveAndQuit(terminal, outputBuffer);

    verifyFileContent(testFile, lines.join("\n") + "\n\n");

    terminal.kill();
    cleanup();
  });

  it("should handle vi commands (:w, :q)", async () => {
    const { terminal, outputBuffer, waitForPrompt, testFile, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    await startVi(terminal, outputBuffer);
    await enterInsertMode(terminal, outputBuffer);

    await typeText(terminal, outputBuffer, "Temporary content\n");
    await exitInsertMode(terminal, outputBuffer);

    // Save without quitting
    await saveWithoutQuit(terminal, outputBuffer);

    // Verify file exists and has content
    verifyFileContent(testFile, "Temporary content\n\n");

    // Quit without saving (should work since already saved)
    await sendCommand(terminal, outputBuffer, ":q\n");
    await waitForOutput(outputBuffer, "$ ");

    terminal.kill();
    cleanup();
  });

  it("should handle large text input without data loss", async () => {
    const { terminal, outputBuffer, waitForPrompt, testFile, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    await startVi(terminal, outputBuffer);
    await enterInsertMode(terminal, outputBuffer);

    // Generate large text (100 lines)
    const largeText =
      Array.from(
        { length: 100 },
        (_, i) => `This is line number ${i + 1} of the test file.`
      ).join("\n") + "\n";

    await typeText(terminal, outputBuffer, largeText);
    await exitInsertMode(terminal, outputBuffer);
    await saveAndQuit(terminal, outputBuffer);

    const content = readFileSync(testFile, "utf8");
    expect(content).toBe(largeText + "\n");
    expect(content.split("\n").length).toBe(102); // 100 lines + 2 empty lines

    terminal.kill();
    cleanup();
  });

  it("should handle special characters and escape sequences", async () => {
    const { terminal, outputBuffer, waitForPrompt, testFile, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    await startVi(terminal, outputBuffer);
    await enterInsertMode(terminal, outputBuffer);

    // Type text with special characters
    const specialText = "Special chars: éñüñ 中文 🚀\nTabs:\t\tIndented\n";
    await typeText(terminal, outputBuffer, specialText);

    await exitInsertMode(terminal, outputBuffer);
    await saveAndQuit(terminal, outputBuffer);

    verifyFileContent(testFile, specialText + "\n");

    terminal.kill();
    cleanup();
  });

  it("should handle vi command mode navigation", async () => {
    const { terminal, outputBuffer, waitForPrompt, testFile, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    await startVi(terminal, outputBuffer);
    await enterInsertMode(terminal, outputBuffer);

    await typeText(
      terminal,
      outputBuffer,
      "First line\nSecond line\nThird line\n"
    );
    await exitInsertMode(terminal, outputBuffer);

    // Navigate using h,j,k,l keys
    await sendCommand(terminal, outputBuffer, "k"); // Up to third line
    await sendCommand(terminal, outputBuffer, "k"); // Up to second line
    await sendCommand(terminal, outputBuffer, "A"); // Append mode
    await sendCommand(terminal, outputBuffer, " - appended");

    await exitInsertMode(terminal, outputBuffer);
    await saveAndQuit(terminal, outputBuffer);

    const content = readFileSync(testFile, "utf8");
    expect(content).toContain("Second line - appended");

    terminal.kill();
    cleanup();
  });

  it("should handle file already exists scenario", async () => {
    const { terminal, outputBuffer, waitForPrompt, testFile, cleanup } =
      createTestTerminal();

    // Create file first
    const initialContent = "Existing content\n";
    require("node:fs").writeFileSync(testFile, initialContent);

    await waitForPrompt();
    await startVi(terminal, outputBuffer);

    // Should not show [New] since file exists
    const output = outputBuffer.join("");
    expect(output).not.toMatch(/\[New\]/);

    // Add more content
    await enterInsertMode(terminal, outputBuffer);
    await typeText(terminal, outputBuffer, "Additional content\n");
    await exitInsertMode(terminal, outputBuffer);

    await saveAndQuit(terminal, outputBuffer);

    verifyFileContent(testFile, "Additional content\nExisting content\n");

    terminal.kill();
    cleanup();
  });

  it("should handle force quit without saving", async () => {
    const { terminal, outputBuffer, waitForPrompt, testFile, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    await startVi(terminal, outputBuffer);
    await enterInsertMode(terminal, outputBuffer);
    await typeText(
      terminal,
      outputBuffer,
      "This content should not be saved\n"
    );
    await exitInsertMode(terminal, outputBuffer);

    // Force quit without saving
    await quitWithoutSaving(terminal, outputBuffer);

    // File should not exist or be empty
    if (existsSync(testFile)) {
      const content = readFileSync(testFile, "utf8");
      expect(content).toBe(""); // Should be empty since we didn't save
    }

    terminal.kill();
    cleanup();
  });

  it("should handle terminal resize during vi editing", async () => {
    const { terminal, outputBuffer, waitForPrompt, testFile, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    await startVi(terminal, outputBuffer);
    await enterInsertMode(terminal, outputBuffer);
    await typeText(terminal, outputBuffer, "Content before resize\n");

    // Resize terminal
    terminal.resize(120, 30);

    await typeText(terminal, outputBuffer, "Content after resize\n");
    await exitInsertMode(terminal, outputBuffer);

    await saveAndQuit(terminal, outputBuffer);

    verifyFileContent(
      testFile,
      "Content before resize\nContent after resize\n\n"
    );

    terminal.kill();
    cleanup();
  });

  it("should handle cd command and edit file in subdirectory", async () => {
    const { terminal, outputBuffer, waitForPrompt, testDir, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    // Create subdirectory
    await sendCommand(terminal, outputBuffer, "mkdir subdir\n");
    await waitForOutput(outputBuffer, "$ ");

    // Change to subdirectory
    await sendCommand(terminal, outputBuffer, "cd subdir\n");
    await waitForOutput(outputBuffer, "$ ");

    // Start vi in subdirectory
    await startVi(terminal, outputBuffer);
    await enterInsertMode(terminal, outputBuffer);

    await typeText(terminal, outputBuffer, "Content in subdirectory\n");
    await exitInsertMode(terminal, outputBuffer);

    await saveAndQuit(terminal, outputBuffer);

    // Verify file was created in subdirectory
    const subDirFile = join(testDir, "subdir", "test.txt");
    expect(existsSync(subDirFile)).toBe(true);
    const content = readFileSync(subDirFile, "utf8");
    expect(content).toBe("Content in subdirectory\n\n");

    terminal.kill();
    cleanup();
  });

  it("should handle command chaining with && operator", async () => {
    const { terminal, outputBuffer, waitForPrompt, testDir, cleanup } =
      createTestTerminal();
    await waitForPrompt();

    // Execute chained commands: create dir, change dir, and start vi
    await sendCommand(terminal, outputBuffer, "mkdir chained && cd chained && vi test.txt\n");

    // Wait for vi to start
    await waitForOutput(outputBuffer, /~/);

    await enterInsertMode(terminal, outputBuffer);
    await typeText(terminal, outputBuffer, "Content from chained commands\n");
    await exitInsertMode(terminal, outputBuffer);

    await saveAndQuit(terminal, outputBuffer);

    // Verify file was created in the chained directory
    const chainDirFile = join(testDir, "chained", "test.txt");
    expect(existsSync(chainDirFile)).toBe(true);
    const content = readFileSync(chainDirFile, "utf8");
    expect(content).toBe("Content from chained commands\n\n");

    terminal.kill();
    cleanup();
  });
});
