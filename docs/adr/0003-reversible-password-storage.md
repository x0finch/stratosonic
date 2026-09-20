# Passwords are stored reversibly encrypted (AES-GCM), not hashed

Subsonic token auth sends `t = md5(password + salt)` with a fresh per-request
salt, so the server must recover the plaintext password to verify a request; a
one-way hash such as bcrypt is impossible. Following Navidrome, we store each
password AES-GCM-encrypted with a key held in a Worker secret (never in the
repo), decrypt it to verify the token in constant time, and also accept the
`p=` / `p=enc:<hex>` plaintext fallback.

## Consequences

Password confidentiality rests on the Worker secret rather than on a slow hash.
This is an inherent constraint of the Subsonic protocol, not a shortcut — no
compliant server can store these passwords one-way.
