# v1 is a spec-faithful, client-agnostic Subsonic server with no transcoding

We implement the OpenSubsonic API faithfully — correct required fields, and both
XML and JSON output — rather than tuning to a single client, because the primary
client (Substreamer) is closed-source and we cannot rely on reading its quirks;
a spec-correct server serves Substreamer, Amperfy, and future clients alike. v1
does no server-side transcoding and returns original files, since iOS clients
play mp3/m4a/flac natively and any external transcoder would turn R2's free
egress into billed bandwidth.

## Consequences

- XML is the default (no `f` param); a JSON renderer serves the same object tree
  when `f=json`.
- The Amperfy source research still applies as a strictness baseline (millisecond
  timestamps, accurate `albumCount`, XML escaping, omitting empty `coverArt`),
  because those are spec-correctness issues, not Amperfy-specific quirks.
- If a client ever refuses a non-mp3 original, the fallback is to pre-transcode
  copies locally in the CLI, not to transcode at request time.
