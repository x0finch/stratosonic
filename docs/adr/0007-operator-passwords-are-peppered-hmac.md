# Operator passwords are a peppered HMAC-SHA256, not a slow hash

The admin console has accounts of its own, operators, separate from Subsonic
users (#99). An operator's password is never sent to Subsonic, so unlike a
Subsonic password (ADR-0003) it need not be recoverable, and it is hashed one
way. The usual choice, a slow hash, does not fit the Workers Free plan's 10 ms
of CPU per request: PBKDF2-SHA256 measured about 10 ms at 10,000 iterations
and 77 ms at 100,000, and Better Auth's default, scrypt, about 100 ms. So we
store `hmac-sha256$v1$<salt>$<digest>`: HMAC-SHA256 over a random 16-byte salt
and the password, keyed by a pepper that HKDF-SHA256 derives from the
`PASSWORD_ENCRYPTION_KEY` secret (`info` `stratosonic/console-password-pepper/v1`),
compared in constant time. Hashing or verifying one costs about 0.1 ms.

## Consequences

A leaked database alone is useless: every digest is keyed by a secret the
database does not hold, which is the same trust boundary ADR-0003 already
accepts for Subsonic passwords. Whoever holds the key as well can test
guesses at HMAC speed, which a slow hash would have made expensive; that is
the price of fitting the Free plan, and one the Subsonic passwords, readable
outright with the key, already exceed. The `v1` in the format and the pepper's
`info` leave room for another scheme, verified alongside this one, if the
budget ever allows it.
