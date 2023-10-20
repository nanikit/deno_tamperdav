import { arrayToXml } from "./array_to_xml.ts";
import { chokidar, Deferred, join, normalize } from "./deps.ts";

export const watcherCache = {} as Record<
  string,
  {
    changes: Record<string, boolean>[];
    timeout?: number | null;
    current_cursor: number;
  }
>;
export const subscribers = {} as Record<string, Record<string, Deferred<Response>>>;

export type HasRelativePath = {
  root: string;
  relativePath: string;
};

const watchers = {} as Record<string, chokidar.FSWatcher>;

export function assureWatcher(
  { root, relativePath, metaTouch = false }: HasRelativePath & { metaTouch?: boolean },
) {
  if (watchers[relativePath]) {
    return;
  }

  const fpath = join(root, relativePath);
  let cache: (typeof watcherCache)[""];
  const watcher = chokidar.watch(fpath, {
    ignored: /^\./,
    atomic: true,
    ignoreInitial: true,
  });

  watcher
    .on("add", onChangeWithGuard)
    .on("change", onChangeWithGuard)
    .on("unlink", onChangeWithGuard)
    .on("error", () => {
      notifySubscribers({
        root,
        relativePath,
        changedFiles: cache ? Object.keys(cache.changes) : [],
      });
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
      new RegExp("^" + regexEscape(fpath) + "/?"),
      "",
    );
    if (metaTouch) {
      const guid = path.match(/(.*)\.user.js$/)?.[1];
      if (guid) {
        await Deno.utime(`${guid}.meta.json`, new Date(), new Date());
      }
    }
    if (!cache) {
      cache = watcherCache[relativePath] = {
        changes: [],
        timeout: null,
        current_cursor: 1,
      };
    }
    const changes = (cache.changes[cache.current_cursor] ??= {});
    changes[filename] ||= true;
    if (cache.timeout) {
      clearTimeout(cache.timeout);
    }
    // collect all changes until there is no change for one second
    cache.timeout = setTimeout(() => {
      sendCachedWatcherChanges({ root, relativePath, fromCursor: cache.current_cursor });
      const o = watcherCache[relativePath];
      o.timeout = null;
      cache.current_cursor++;
    }, 1000);
  }
}

export function sendCachedWatcherChanges(
  { root, relativePath, fromCursor }: HasRelativePath & { fromCursor: number },
) {
  const changes = watcherCache[relativePath];
  if (!changes) {
    return;
  }

  for (let i = fromCursor; i <= changes.current_cursor; i++) {
    const current = changes.changes[i];
    if (current) {
      notifySubscribers({ root, relativePath, changedFiles: Object.keys(current), cursor: i + 1 });
    }
  }
}

async function notifySubscribers(
  { root, relativePath, changedFiles, cursor }: HasRelativePath & {
    changedFiles: string[];
    cursor?: number;
  },
) {
  const subscriber = subscribers[relativePath];
  if (!subscriber) {
    return;
  }

  subscribers[relativePath] = {};
  const xml = await arrayToXml({ root, relativePath, files: changedFiles, cursor });

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

function regexEscape(s: string) {
  return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}
