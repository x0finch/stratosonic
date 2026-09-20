# Unknown `/rest/` endpoints return a Subsonic error 70, not a bare 404

A request to a `/rest/<name>` we do not implement is answered with a normal
Subsonic envelope carrying `status="failed"` and `<error code="70"
message="view not found"/>`, in whichever format the client asked for. This
follows gonic (`Controller.ServeNotFound`) rather than Navidrome, which lets
its router return a bare HTML 404: a client that reaches an endpoint we have
not built yet gets a response its XML or JSON parser understands and can report
to the user, instead of a parse failure. Paths outside `/rest/` are not the
Subsonic API and still return a plain HTTP 404.

## Consequences

This is a deliberate deviation from the default of staying faithful to
Navidrome, recorded here so it is not "corrected" back to a bare 404. It costs
nothing at cutover, because a client only sees it for endpoints that do not
exist on either server.
