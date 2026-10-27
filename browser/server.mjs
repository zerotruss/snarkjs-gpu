// A tiny static file server for the browser tests: maps URL prefixes to folders (no path escapes) and
// serves one generated page at "/" (the page can depend on the query string).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize } from "node:path";

const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".html": "text/html" };

/** @param routes  [[urlPrefix, folder], ...]   @param page  (URLSearchParams) => html string */
export async function startServer(routes, page) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = decodeURIComponent(url.pathname);
    if (path === "/") {
      res.setHeader("content-type", "text/html");
      return res.end(page(url.searchParams));
    }
    for (const [prefix, dir] of routes) {
      if (!path.startsWith(prefix)) continue;
      const file = normalize(`${dir}/${path.slice(prefix.length)}`);
      if (!file.startsWith(dir)) break;
      try {
        res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
        return res.end(await readFile(file));
      } catch {
        break;
      }
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
