import { createApp } from "./app";

const app = createApp();

export default {
  fetch: app.fetch,
  // Library ingestion runs on a cron schedule (ADR-0004); it is implemented in
  // a later phase, so the handler is a no-op for now.
  scheduled: async () => {},
} satisfies ExportedHandler<Cloudflare.Env>;
