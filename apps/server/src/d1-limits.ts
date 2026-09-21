/**
 * What D1 refuses to run, as numbers the query builders can respect.
 *
 * The tests run against Miniflare, which is real SQLite and far more
 * permissive, so nothing but a constant here stands between a statement built
 * from unbounded input - a scan page's rows, a search query's words - and a
 * failure that only ever happens in production.
 */

/**
 * D1's ceiling on bound parameters in one query
 * (developers.cloudflare.com/d1/platform/limits). SQLite's own limit is 999,
 * so a statement that binds per row or per word passes every test and throws
 * `too many SQL variables` against D1.
 */
export const D1_MAX_BOUND_PARAMETERS = 100;
