import { describe, it, expect } from "bun:test";
import { Terminal } from "./terminal";

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("Terminal - Integration Tests", () => {
	describe("Interactive PTY", () => {
		it("should receive command output in interactive mode", async () => {
			const term = new Terminal("sh", ["-c", `
				while true; do
					read -p "> " cmd
					[ "$cmd" = "exit" ] && break
					eval "$cmd" 2>&1
				done
			`], {
				name: "xterm",
				cols: 80,
				rows: 24,
			});

			let received = "";
			const unsub = term.onData((data) => {
				received += data;
			});

			await delay(50);
			
			term.write("echo hello-from-shell\n");
			await delay(100);

			term.write("exit\n");
			await delay(100);

			term.kill();
			await delay(50);
			unsub.dispose();

			expect(received).toContain("hello-from-shell");
			expect(received.length).toBeGreaterThan(20);
		});

		it("should handle rapid command succession", async () => {
			const term = new Terminal("sh", ["-c", `
				while true; do
					read -p "> " cmd
					[ "$cmd" = "exit" ] && break
					eval "$cmd" 2>&1
				done
			`], {
				name: "xterm",
				cols: 80,
				rows: 24,
			});

			let packets = 0;
			const unsub = term.onData((_data) => {
				packets++;
			});

			await delay(50);
			
			for (let i = 0; i < 3; i++) {
				term.write(`echo test${i}\n`);
				await delay(30);
			}
			
			term.write("exit\n");
			await delay(100);

			term.kill();
			await delay(50);
			unsub.dispose();

			expect(packets).toBeGreaterThan(0);
		});
	});



	describe("Buffer Management", () => {
		it("should handle large output correctly", async () => {
			const term = new Terminal("sh", ["-c", `
				while true; do
					read -p "> " cmd
					[ "$cmd" = "exit" ] && break
					eval "$cmd" 2>&1
				done
			`], {
				name: "xterm",
				cols: 80,
				rows: 24,
			});

			let received = "";
			const unsub = term.onData((data) => {
				received += data;
			});

			await delay(50);
			
			// Generate large output
			term.write("yes hello | head -100\n");
			await delay(200);

			term.write("exit\n");
			await delay(100);

			term.kill();
			await delay(50);
			unsub.dispose();

			const helloCount = (received.match(/hello/g) || []).length;
			expect(helloCount).toBeGreaterThan(50);
		});
	});
});
