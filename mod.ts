import {
  Deferred,
  deferred,
} from "https://deno.land/std@0.203.0/async/deferred.ts";
import {
  join,
  normalize,
  resolve,
} from "https://deno.land/std@0.203.0/path/mod.ts";
import { open } from "https://deno.land/x/open@v0.0.6/index.ts";
import chokidar from "npm:chokidar";
import dialog from "npm:dialog";

let args = {} as Record<string, unknown>;

function error(m: unknown) {
  console.error(m);
  if (!args["no-dialog"] && !args.headless) {
    dialog.err(m, "TamperDAV");
  }
}

function warn(m: unknown) {
  console.warn(m);
  if (!args["no-dialog"] && !args.headless) {
    dialog.warn(m, "TamperDAV");
  }
}

// early parsing for the config option
const optionConfig = Deno.args.reduce(
  (a, c) => c.split("--config=")[1] || a,
  "",
);
const config = optionConfig || "config.json";

try {
  args = JSON.parse(await Deno.readTextFile(config));
} catch (err) {
  if (!(err instanceof Deno.errors.NotFound)) {
    error(`${config}: ${err.message}`);
    Deno.exit(1);
  }
}

for (const k of ["username", "password"]) {
  args[k] = args[k] || Deno.env.get("TD_" + k.toUpperCase());
}

for (const val of Deno.args) {
  const s = val.replace(/^[-]{1,2}/, "").split("=");
  args[s[0]] = s[1] || true;
}

if (Deno.args.includes("--help")) {
  const { os } = Deno.build;
  console.log(
    `Usage: ${os === "windows" ? "TamperDAV.bat" : "./tamperdav.sh"} [options]
Starts a WebDAV server using Node.js

Options:
        --help                     Shows this information
        --config=[path]            Uses the specified config file (default: config.json)
        --no-auth-warning          Disables the warning regarding missing authentication due
                                   to missing username and password
        --meta-touch               Updates corresponding meta file upon changing a script
                                   file, resulting in connected browsers syncing these changes
        --debug                    Provides some more detailed output for debugging purposes
        --open-in-editor=[editor]  The editor to use when pressing the cloud editor icon in
                                   Tampermonkey
        --open-in-editor           Same as above, but uses ${
      os === "windows" ? "notepad.exe" : "the editor chosen by xdg-open"
    }
        --username=[username]      The username for clients to authenticate to the server with
        --password=[password]      The password for clients to authenticate to the server with
        --host=[host]              The network address to bind on (default: localhost)
        --port=[port]              The port that the server will listen on (default: 7000)
        --path=[path]              The path, relativePath to server.js, that will serve as storage
        --no-dialog                Disables the use of a dialog to show messages to the user
        --headless                 Implies --no-dialog and disables editor opening

All of these options except "--help" can be specified in a JSON formatted file config.json
in the same directory as server.js. An example is:
{
    "path": "dav",
    "meta-touch": true,
    "username": "foo",
    "password": "bar",
    "port": 1234
}

Options provided as command line parameters all have precedence over options stored in the
config file.

Username and password can also be specified in the environment variables TD_USERNAME and
TD_PASSWORD respectively. These have priority over over the config file, but not over the
command line parameters.
`,
  );
  Deno.exit(0);
}

if (!args.path) {
  error("path arguments missing");
  Deno.exit(1);
}

const working_dir = join(".", args.path as string);
await Deno.mkdir(working_dir, { recursive: true });

if (!args["no-auth-warning"] && (!args.username || !args.password)) {
  warn(
    "TamperDAV is running without any form of authentication. It's strongly recommended to configure username and password!",
  );
}

function regexEscape(s: string) {
  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}

const port = args.port || 7000;
const subscribers = {} as Record<string, Record<string, Deferred<Response>>>;

const methods = {
  options: (_request: Request) => {
    const allowed_methods = [
      "GET",
      "HEAD",
      "OPTIONS",
      "PUT",
      "PROPFIND",
      "MKCOL",
      "DELETE",
      "SUBSCRIBE",
    ].concat(args["open-in-editor"] ? ["EDITOR"] : []).join(",");

    return new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Methods": allowed_methods,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers":
          "Authorization,User-Agent,Content-Type,Accept,Origin,X-Requested-With,Cursor",
      },
    });
  },
  propfind: async (request: Request) => {
    const relativePath = new URL(request.url).pathname;

    try {
      const xml = await readAsXml(relativePath, {
        recursive: request.headers.get("depth") !== "0",
      });
      return new Response(xml, {
        status: 207,
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
        },
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return new Response(null, { status: 404 });
      }
      throw error;
    }
  },
  mkcol: async (request: Request) => {
    const relativePath = new URL(request.url).pathname;
    const fpath = join(working_dir, relativePath);

    try {
      await Deno.mkdir(fpath);
      return methods.propfind(request);
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        return new Response(
          '<d:error xmlns:d="DAV:" xmlns:td="http://dav.tampermonkey.net/ns"><td:exception>MethodNotAllowed</td:exception><td:message>The resource you tried to create already exists</td:message></d:error>',
          {
            status: 405,
            headers: { "Content-Type": "application/xml; charset=utf-8" },
          },
        );
      }
      return new Response(`${error}`, { status: 422 });
    }
  },
  get: async (request: Request) => {
    const relativePath = new URL(request.url).pathname;
    const filePath = join(working_dir, relativePath);

    try {
      const content = await Deno.readFile(filePath);
      return new Response(content, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return new Response(null, { status: 404 });
      }
      throw error;
    }
  },
  editor: async (request: Request) => {
    let editor = args["open-in-editor"] as string | boolean | undefined;
    if (!editor || args.headless) {
      return new Response(null, { status: 501 });
    }
    if (editor === true) {
      if (Deno.build.os === "windows") {
        editor = "notepad";
      } else {
        editor = "xdg-open";
      }
    }

    const url = new URL(request.url);
    const relativePath = url.pathname;
    const path = join(working_dir, relativePath);

    try {
      await Deno.stat(path);
      open(resolve(path), { app: editor });
      return new Response(null, {
        status: 302,
        headers: {
          "Location": `dav://${request.headers.get("host")}${url.pathname}`,
        },
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return new Response(null, { status: 404 });
      }
      throw error;
    }
  },
  put: async (request: Request) => {
    const relativePath = new URL(request.url).pathname;
    const filePath = join(working_dir, relativePath);
    const file = await Deno.open(filePath, {
      create: true,
      truncate: true,
      write: true,
    });
    await request.body?.pipeTo(file.writable, { signal: request.signal });

    const timestamp = request.headers.get("x-oc-mtime");
    const headers = {} as Record<string, string>;
    if (timestamp) {
      const date = new Date(Math.floor(Number(timestamp) * 1000));
      await Deno.utime(filePath, date, date);
      headers["X-OC-Mtime"] = "accepted";
    }
    return new Response(null, { status: 200, headers });
  },
  delete: async (request: Request) => {
    const relativePath = new URL(request.url).pathname;
    const path = join(working_dir, relativePath);

    try {
      await Deno.remove(path);
      return new Response(null, { status: 204 });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return new Response(null, { status: 404 });
      }
      throw error;
    }
  },
  head: async (request: Request) => {
    const relativePath = new URL(request.url).pathname;
    const filePath = join(working_dir, relativePath);

    try {
      const stat = await Deno.stat(filePath);
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Length": stat.size.toString(),
          "Content-Type": "application/octet-stream",
        },
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return new Response(null, { status: 404 });
      }
      throw error;
    }
  },
  subscribe: async (request: Request) => {
    const relativePath = new URL(request.url).pathname;
    const filePath = join(working_dir, relativePath);

    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(filePath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return new Response(null, { status: 404 });
      }
      throw error;
    }

    if (!stat.isDirectory) {
      return new Response(null, { status: 400 });
    }

    const id = crypto.randomUUID();

    const response = deferred<Response>();
    request.signal.addEventListener("abort", () => {
      response.reject(request.signal.reason);
    });
    (subscribers[relativePath] ??= {})[id] = response;

    assureWatcher(relativePath);

    const uri = new URL(request.url);
    const url_args = getUrlArgs(uri.search || "");
    let from_cursor;
    if ((from_cursor = url_args.cursor || request.headers.get("cursor"))) {
      sendCachedWatcherChanges(relativePath, parseInt(from_cursor, 10));
    }

    return response;
  },
} as const;

function getUrlArgs(url: string) {
  const c = {} as Record<string, string>;
  const p = url.replace(/^\?/, "");

  const args = p.split("&");
  let pair;

  for (let i = 0; i < args.length; i++) {
    pair = args[i].split("=");
    if (pair.length != 2) {
      const p1 = pair[0];
      const p2 = pair.slice(1).join("=");
      pair = [p1, p2];
    }
    c[pair[0]] = decodeURIComponent(pair[1]);
  }

  return c;
}

async function notifySubscribers(
  relativePath: string,
  changedFiles: string[],
  cursor?: number,
) {
  const subscriber = subscribers[relativePath];
  if (!subscriber) {
    return;
  }

  subscribers[relativePath] = {};
  const xml = await arrayToXml(relativePath, changedFiles, cursor);

  for (const [id, response] of Object.entries(subscriber)) {
    response.resolve(
      new Response(xml, {
        status: 207,
        headers: { "Content-Type": "application/xml; charset=utf-8" },
      }),
    );
    delete subscriber[id];
  }
}

const watcherCache = {} as Record<
  string,
  {
    changes: Record<string, boolean>[];
    timeout?: number | null;
    current_cursor: number;
  }
>;

function sendCachedWatcherChanges(relativePath: string, from_cursor: number) {
  const changes = watcherCache[relativePath];
  if (!changes) {
    return;
  }

  for (let i = from_cursor; i <= changes.current_cursor; i++) {
    const current = changes.changes[i];
    if (current) {
      notifySubscribers(relativePath, Object.keys(current), i + 1);
    }
  }
}

const watchers = {} as Record<string, chokidar.FSWatcher>;
function assureWatcher(relativePath: string) {
  if (watchers[relativePath]) {
    return;
  }

  const fpath = join(working_dir, relativePath);
  let cache: typeof watcherCache[""];
  const watcher = chokidar.watch(fpath, {
    ignored: /^\./,
    atomic: true,
    ignoreInitial: true,
  });

  watcher.on("add", onChangeWithGuard)
    .on("change", onChangeWithGuard)
    .on("unlink", onChangeWithGuard)
    .on("error", () => {
      notifySubscribers(relativePath, cache ? Object.keys(cache.changes) : []);
    });

  watchers[relativePath] = watcher;

  async function onChangeWithGuard(rawPath: string) {
    try {
      await onChange(rawPath);
    } catch (error) {
      console.error(error);
    }
  }

  async function onChange(rawPath: string) {
    const path = normalize(rawPath);
    const filename = path.replace(
      new RegExp("^" + regexEscape(fpath) + "\/?"),
      "",
    );
    if (args["meta-touch"]) {
      const guid = path.match(/(.*)\.user.js$/)?.[1];
      if (guid) {
        const file = await Deno.open(`${guid}.meta.json`);
        try {
          await Deno.futime(file.rid, new Date(), new Date());
        } finally {
          file.close();
        }
      }
    }
    if (!cache) {
      cache = watcherCache[relativePath] = {
        changes: [],
        timeout: null,
        current_cursor: 1,
      };
    }
    const changes = cache.changes[cache.current_cursor] ??= {};
    changes[filename] ||= true;
    if (cache.timeout) {
      clearTimeout(cache.timeout);
    }
    // collect all changes until there is no change for one second
    cache.timeout = setTimeout(() => {
      sendCachedWatcherChanges(relativePath, cache.current_cursor);
      const o = watcherCache[relativePath];
      o.timeout = null;
      cache.current_cursor++;
    }, 1000);
  }
}

Deno.serve({
  hostname: args.host as string || "localhost",
  port: port as number,
  onError: (error) => {
    console.error(error);
    return new Response(`${error}`);
  },
}, logAndHandleRequest);
console.log(`server is listening on ${port}`);

async function logAndHandleRequest(request: Request): Promise<Response> {
  if (args.debug) {
    console.log("###");
    console.log(`${request.method} ${request.url}`);
    request.headers.forEach((v, k) => {
      if (
        k.match(
          /accept|connection|content-type|dnt|host|origin|sec-|user-agent/i,
        )
      ) {
        return;
      }
      console.log(`${k}: ${v}`);
    });
  }

  let response: Response;
  try {
    response = await handleRequest(request);
  } catch (error) {
    response = new Response(`${error}`, { status: 500 });
  }

  if (args.debug) {
    console.log("###");
    console.log(`${request.method} ${request.url} -> ${response.status}`);
    response.headers.forEach((v, k) => {
      console.log(`${k}: ${v}`);
    });
    console.log("");
    const text = await response.clone().text();
    console.log(text);
  }

  return response;
}

async function handleRequest(request: Request): Promise<Response> {
  if (!isAuthorized(request)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Enter credentials"' },
    });
  }

  const uri = new URL(request.url);
  const searchParams = new URLSearchParams(uri.search);
  const method = searchParams.get("method") || request.method.toLowerCase();
  const handler = methods[method as keyof typeof methods];
  if (handler) {
    const response = await handler(request);
    response.headers.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, post-check=0, pre-check=0",
    );
    response.headers.set("DAV", "1");
    return response;
  } else {
    return new Response(`unknown method ${request.method}`, { status: 501 });
  }
}

function isAuthorized(request: Request): boolean {
  if (!(args.username || args.password)) {
    return true;
  }
  const auth = request.headers.get("authorization");
  const [user, pass] = auth?.match("Basic (.*)")?.[1]?.split(":") ?? [];
  return user == args.username || pass == args.password;
}

async function readAsXml(
  relativePath: string,
  { recursive }: { recursive: boolean },
) {
  const path = join(working_dir, relativePath);

  const info = await Deno.stat(path);
  if (!info.isDirectory) {
    return arrayToXml(relativePath, [""]);
  }

  const wc = watcherCache[relativePath];
  const files = [];
  if (recursive) {
    for await (const entry of Deno.readDir(path)) {
      files.push(entry.name);
    }
  }

  return arrayToXml(
    relativePath,
    ["."].concat(files || []),
    wc && recursive ? wc.current_cursor : undefined,
  );
}

async function arrayToXml(
  relativePath: string,
  files: string[],
  cursor?: number,
) {
  const fpath = join(working_dir, relativePath);

  const xmls = await Promise.all(files.map(buildItemXml));
  const new_cursor = cursor ? `<td:cursor>${cursor}</td:cursor>` : "";
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:td="http://dav.tampermonkey.net/ns">${
    xmls.join("\n")
  }${new_cursor}</d:multistatus>`;

  async function buildItemXml(file: string) {
    const name = file;
    const canonicalPath = join(fpath, name);

    let stats, dir;
    try {
      stats = await Deno.stat(canonicalPath);
      dir = stats.isDirectory;
    } catch (_e) {
      stats = {
        mtime: Date.now(),
        size: -1,
      };
      dir = false;
    }

    const mtime = new Date(stats.mtime || Date.now());
    const size = stats.size;
    const lastModified = mtime.toUTCString();

    return [
      "<d:response>",
      `<d:href>${join(relativePath, name)}</d:href>`,
      "<d:propstat>",
      "<d:prop>",
      `<d:getlastmodified>${lastModified}</d:getlastmodified>`,
      dir
        ? "<d:resourcetype><d:collection/></d:resourcetype>"
        : "<d:resourcetype />",
      !dir
        ? `<d:getcontentlength>${size}</d:getcontentlength>`
        : "<d:getcontentlength />",
      "</d:prop>",
      "<d:status>HTTP/1.1 200 OK</d:status>",
      "</d:propstat>",
      "</d:response>",
    ].filter(function (e) {
      return e;
    }).join("\n");
  }
}
