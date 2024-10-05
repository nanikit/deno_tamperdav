import { debounce } from "jsr:@std/async/debounce";
import { relative, resolve } from "jsr:@std/path";
import { normalize } from "jsr:@std/path/posix";

export type SubscriptionRequest = {
  /** relative path */
  path: string;
  depth: number;
  timeoutSeconds: number;
  signal: AbortSignal;
};

export function toSubscription(request: Request): SubscriptionRequest {
  return {
    path: normalize(`${new URL(request.url).pathname}`.replace(/^\/+|\/+$/g, "")) || ".",
    timeoutSeconds: getTimeoutSeconds(request),
    depth: getDepth(request),
    signal: request.signal,
  };
}

function getTimeoutSeconds(request: Request) {
  return (Number(request.headers.get("timeout")) || 60);
}

function getDepth(request: Request) {
  return Number(request.headers.get("depth") ?? 0);
}

export class FsSubscriber implements Disposable {
  readonly #root: string;

  readonly #changes = new Set<string>();
  readonly #requests = new Set<SubscriptionRequest>();
  readonly #resolvers = new Map<SubscriptionRequest, PromiseWithResolvers<Set<string>>>();
  readonly #watchers = new Map<string, Deno.FsWatcher>();

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async subscribe(request: SubscriptionRequest): Promise<Set<string>> {
    const { path, timeoutSeconds, depth, signal } = request;

    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }

    signal.addEventListener("abort", () => {
      this.#resolvers.get(request)?.reject(signal.reason);
    });

    this.#requests.add(request);
    const resolver = Promise.withResolvers<Set<string>>();
    this.#resolvers.set(request, resolver);

    const timeoutId = setTimeout(() => {
      resolver.resolve(new Set());
    }, timeoutSeconds * 1000);

    this.#watch(path, { recursive: depth === 0 });

    try {
      return await resolver.promise;
    } finally {
      clearTimeout(timeoutId);
      this.#resolvers.delete(request);
      this.#requests.delete(request);
    }
  }

  [Symbol.dispose](): void {
    this.#changes.clear();
    this.#requests.clear();
    this.#notify.clear();

    const error = new Error("aborted");
    for (const resolver of this.#resolvers.values()) {
      resolver.reject(error);
    }
    this.#resolvers.clear();

    for (const watcher of this.#watchers.values()) {
      watcher.close();
    }
    this.#watchers.clear();
  }

  async #watch(path: string, { recursive }: { recursive: boolean }) {
    const id = `${path}-${recursive ? "/**" : ""}`;
    if (this.#watchers.has(id)) {
      return;
    }

    const target = resolve(this.#root, path);
    const watcher = Deno.watchFs(target, { recursive });
    this.#watchers.set(id, watcher);

    const trivialKinds: Deno.FsEvent["kind"][] = ["access", "any", "other"];

    for await (const event of watcher) {
      if (trivialKinds.includes(event.kind)) {
        continue;
      }

      for (const path of event.paths) {
        const relativePath = relative(this.#root, path).replace(/\\/g, "/");
        this.#changes.add(relativePath);
      }

      this.#notify();
    }
  }

  #notify = debounce(() => {
    if (this.#changes.size === 0) {
      return;
    }

    for (const request of this.#requests) {
      const paths = new Set<string>();

      for (const path of this.#changes) {
        const isSubPath = path.startsWith(`${request.path}/`) || request.path === ".";
        const isNotRelated = path !== request.path && !isSubPath;
        if (isNotRelated) {
          continue;
        }

        paths.add(path);
      }

      const resolver = this.#resolvers.get(request);
      if (!resolver || paths.size === 0) {
        continue;
      }

      resolver.resolve(paths);
    }

    this.#changes.clear();
  }, 500);
}
