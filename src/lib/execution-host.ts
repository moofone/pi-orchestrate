import type { ExecutionBridge } from "./execution-bridge.ts";

/** Extension lifecycle only, not another execution driver. Construction is
 * shared/awaited and read-only; the existing bridge owns admission and leases. */
export function createExecutionHost() {
 let generation = 0, closed = false, abort = new AbortController();
 let bridge: ExecutionBridge | undefined, starting: Promise<ExecutionBridge> | undefined;
 let closing: Promise<void> = Promise.resolve();
 const dispose = async () => {
  const pending = starting; const current = bridge; bridge = undefined;
  if (pending) { try { await pending; } catch { /* initializer owns its cancellation cleanup */ } }
  if (current) await current.shutdown();
 };
 return {
  current: () => bridge,
  get(factory: (signal: AbortSignal) => Promise<ExecutionBridge>): Promise<ExecutionBridge> {
   if (closed) return Promise.reject(new Error("Execution host is shut down"));
   if (bridge) return Promise.resolve(bridge);
   if (starting) return starting;
   const ticket = generation, signal = abort.signal;
   starting = (async () => {
    await closing;
    if (closed || generation !== ticket) throw new Error("Execution host generation cancelled");
    const created = await factory(signal);
    if (closed || generation !== ticket) { await created.shutdown(); throw new Error("Execution host generation cancelled"); }
    bridge = created; return created;
   })().finally(() => { starting = undefined; });
   return starting;
  },
  async reload(factory: (signal: AbortSignal) => Promise<ExecutionBridge>): Promise<ExecutionBridge> {
   const ticket = ++generation; closed = true; abort.abort();
   closing = dispose(); await closing;
   if (generation !== ticket) throw new Error("Execution host generation cancelled");
   closed = false; abort = new AbortController();
   return this.get(factory);
  },
  async shutdown(): Promise<void> {
   ++generation; closed = true; abort.abort();
   const previous = closing; closing = dispose(); await Promise.all([previous, closing]);
  },
 };
}
