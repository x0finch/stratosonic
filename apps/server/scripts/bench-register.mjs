/**
 * Lets the request benches load the Worker's modules in Node (`tsx --import
 * ./scripts/bench-register.mjs …`): `cloudflare:workers`, which only workerd
 * provides, resolves to a stand-in whose `DurableObject` is an empty base
 * class. The `/api` app reaches it through scanner/status.ts, which names the
 * scan driver; no bench runs the driver itself.
 */

import { register } from "node:module";

const workers = `data:text/javascript,${encodeURIComponent(
  "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
)}`;

const hooks = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: ${JSON.stringify(workers)}, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`);
