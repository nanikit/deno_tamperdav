import { expandGlob } from "jsr:@std/fs";
import { join, resolve } from "jsr:@std/path";
import { arrayToXml } from "../array_to_xml.ts";
import { open } from "../deps.ts";
import { FsSubscriber, toSubscription } from "../subscription_handler.ts";

// tampermonkey try subscribing simultaneously, maybe normal + incognito + unknown one + retry one.
const TAMPERMONKEY_VOID_SUBSCRIBE_COUNT = 4;
let subscribeImmediateCount = TAMPERMONKEY_VOID_SUBSCRIBE_COUNT;
let lastSubscribeRequestTime: Date | undefined;

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
  try {
    const recursive = request.headers.get("depth") !== "0";
    const relativePath = "." + new URL(request.url).pathname;
    const target = resolve(root, relativePath);
    const files = await Array.fromAsync(expandGlob(`${target}${recursive ? "/**" : ""}`));
    const xml = await arrayToXml({ root, files: files.map((x) => x.path) });
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

export async function get(request: Request, { root }: { root: string }) {
  const relativePath = new URL(request.url).pathname;
  const filePath = resolve(`${root}${relativePath}`);

  subscribeImmediateCount = Math.max(
    TAMPERMONKEY_VOID_SUBSCRIBE_COUNT,
    subscribeImmediateCount - 1,
  );

  try {
    const file = await Deno.open(filePath);
    return new Response(file.readable, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response(null, { status: 404 });
    }
    if (typeof error === "object" && error && "code" in error && error.code === "EISDIR") {
      return new Response("It is a directory", { status: 400 });
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
  { root, subscriber, metaTouch }: { root: string; subscriber: FsSubscriber; metaTouch: boolean },
) {
  const now = new Date();

  const subscription = toSubscription(request);

  // I don't know why but sometimes tampermonkey sends SUBSCRIBE and PROPFIND request in a very short time.
  const lastDiffTime = now.getTime() - (lastSubscribeRequestTime?.getTime() ?? 0);
  lastSubscribeRequestTime = now;
  if (subscribeImmediateCount > 0) {
    subscription.timeoutSeconds = 0;
    subscribeImmediateCount--;
  } else if (lastDiffTime >= 11000) {
    return await propFind(request, root);
  }

  try {
    let relatives: string[] = [];
    do {
      if (subscription.timeoutSeconds > 0) {
        const lastDiffTime = now.getTime() - (lastSubscribeRequestTime?.getTime() ?? 0);
        subscription.timeoutSeconds = Math.floor(
          Math.max(0, Math.min(10 - lastDiffTime / 1000, 10)),
        );
      }
      relatives = [...await subscriber.subscribe(subscription)];

      if (relatives.length === 0) {
        return new Response(null, { status: 204 });
      }
    } while (relatives.every((x) => x.endsWith(".meta.json")));

    if (metaTouch) {
      const metas = await Promise.all(relatives.map(touchMeta));
      relatives.push(...metas.flat());
    }

    const absolutes = relatives.map((x) => resolve(root, x));
    const xml = await arrayToXml({ root, files: absolutes });

    subscribeImmediateCount = TAMPERMONKEY_VOID_SUBSCRIBE_COUNT;
    return new Response(xml, {
      status: 207,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return new Response(null, { status: 404 });
    }
    throw error;
  }

  async function touchMeta(relativePath: string) {
    try {
      const meta = relativePath.replace(".user.js", ".meta.json");
      const absolute = resolve(root, meta);
      await Deno.utime(absolute, now, now);
      return [meta];
    } catch (_error) {
      return [];
    }
  }
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
