// Regenerate node-cancelled.tap with Node's TAP reporter in a bounded subprocess.
import test from "node:test";
test("selected test", () => {});
test("cancelled test", { timeout: 20 }, async () => {
 const timer = setTimeout(() => {}, 100);
 try { await new Promise(() => {}); } finally { clearTimeout(timer); }
});
