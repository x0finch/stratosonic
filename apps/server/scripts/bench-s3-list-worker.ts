/**
 * The Worker bench-s3-list-workerd.ts runs under `wrangler dev`: it parses a
 * `ListObjectsV2` page of `?entries=` entries `?runs=` times and answers how
 * many objects it read. The page is built once per isolate and size, outside
 * the parses.
 */

import { parseListObjectsV2 } from "../src/storage/s3-list";
import { listingXml } from "./bench-s3-xml";

const pages = new Map<number, string>();

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const entries = Number(url.searchParams.get("entries") ?? "1000");
    const runs = Number(url.searchParams.get("runs") ?? "1");

    let xml = pages.get(entries);
    if (xml === undefined) {
      xml = listingXml(entries);
      pages.set(entries, xml);
    }
    let objects = 0;
    for (let run = 0; run < runs; run++) {
      objects += parseListObjectsV2(xml).objects.length;
    }
    return new Response(String(objects));
  },
};
