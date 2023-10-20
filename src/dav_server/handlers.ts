import { arrayToXml } from "../array_to_xml.ts";
import { deferred, join, open, resolve } from "../deps.ts";
import {
  assureWatcher,
  HasRelativePath,
  sendCachedWatcherChanges,
  subscribers,
  watcherCache,
} from "../watcher_cache.ts";

export function options(openInEditor: boolean) {
  const allowedMethods = [
    "GET",
    "HEAD",
    "OPTIONS",
    "PUT",
    "PROPFIND",
    "MKCOL",
    "DELETE",
    "SUBSCRIBE",
    ...(openInEditor ? ["EDITOR"] : []),
  ].join(",");

  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Methods": allowedMethods,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers":
        "Authorization,User-Agent,Content-Type,Accept,Origin,X-Requested-With,Cursor",
    },
  });
}

export async function propFind(request: Request, root: string) {
  const relativePath = new URL(request.url).pathname;

  try {
    const xml = await readAsXml({
      root,
      relativePath,
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
}
export async function get(request: Request, root: string) {
  const relativePath = new URL(request.url).pathname;
  const filePath = join(root, relativePath);

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
}

export async function put(request: Request, root: string) {
  const relativePath = new URL(request.url).pathname;
  const filePath = join(root, relativePath);
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
}

export async function del(request: Request, working_dir: string) {
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
}

export async function head(request: Request, working_dir: string) {
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
}

export async function makeCollection(request: Request, root: string) {
  const relativePath = new URL(request.url).pathname;
  const fpath = join(root, relativePath);

  try {
    await Deno.mkdir(fpath);
    return await propFind(request, root);
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
}

export async function subscribe(
  request: Request,
  { root, metaTouch }: { root: string; metaTouch: boolean },
) {
  const relativePath = new URL(request.url).pathname;
  const filePath = join(root, relativePath);

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

  assureWatcher({ root: root, relativePath, metaTouch });

  const uri = new URL(request.url);
  const url_args = getUrlArgs(uri.search || "");
  let from_cursor;
  if ((from_cursor = url_args.cursor || request.headers.get("cursor"))) {
    sendCachedWatcherChanges({
      root: root,
      relativePath,
      fromCursor: parseInt(from_cursor, 10),
    });
  }

  return response;
}

export async function editor(
  request: Request,
  { editor, root }: { root: string; editor: string | boolean | undefined },
) {
  if (!editor) {
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
  const path = join(root, relativePath);

  try {
    await Deno.stat(path);
    open(resolve(path), { app: editor });
    return new Response(null, {
      status: 302,
      headers: {
        Location: `dav://${request.headers.get("host")}${url.pathname}`,
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response(null, { status: 404 });
    }
    throw error;
  }
}

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

async function readAsXml(
  { root, relativePath, recursive }: HasRelativePath & { recursive: boolean },
) {
  const path = join(root, relativePath);

  const info = await Deno.stat(path);
  if (!info.isDirectory) {
    return arrayToXml({ root, relativePath, files: [""] });
  }

  const wc = watcherCache[relativePath];
  const files = [];
  if (recursive) {
    for await (const entry of Deno.readDir(path)) {
      files.push(entry.name);
    }
  }

  return arrayToXml({
    root,
    relativePath,
    files: ["."].concat(files || []),
    cursor: wc && recursive ? wc.current_cursor : undefined,
  });
}
