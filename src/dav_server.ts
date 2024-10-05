import { delay } from "jsr:@std/async/delay";
import {
  del,
  editor,
  get,
  head,
  makeCollection,
  options,
  propFind,
  put,
  subscribe,
} from "./dav_server/handlers.ts";
import { resolve } from "./deps.ts";
import { FsSubscriber } from "./subscription_handler.ts";

type DavServerOptions = {
  debug?: boolean;
  verbose?: boolean;
  username?: string;
  password?: string;
  "open-in-editor"?: string;
  "meta-touch"?: boolean;
};

export class DavServer implements Disposable {
  #root: string;
  #subscriber: FsSubscriber;
  #lastRequestId = 0;

  constructor(root: string, private readonly args: DavServerOptions) {
    this.#root = resolve(root);
    this.#subscriber = new FsSubscriber(this.#root);
  }

  logAndHandleRequest = async (request: Request): Promise<Response> => {
    let response: Response;
    try {
      const responsePromise = this.#handleRequest(request);

      this.#logResponsePairIfPossible(request, responsePromise);

      response = await responsePromise;
    } catch (error) {
      response = new Response(`${error}`, { status: 500 });
    }

    return response;
  };

  [Symbol.dispose](): void {
    this.#subscriber[Symbol.dispose]();
  }

  #handleRequest = async (request: Request): Promise<Response> => {
    if (!this.#isAuthorized(request)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Enter credentials"' },
      });
    }

    const response = await this.#handle(request);
    response.headers.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, post-check=0, pre-check=0",
    );
    response.headers.set("DAV", "1");
    return response;
  };

  #handle = async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();
    switch (method) {
      case "OPTIONS":
        return options(!!this.args["open-in-editor"]);
      case "PROPFIND":
        return await propFind(request, this.#root);
      case "GET":
        return await get(request, { root: this.#root });
      case "HEAD":
        return await head(request, this.#root);
      case "PUT":
        return await put(request, this.#root);
      case "MKCOL":
        return await makeCollection(request, this.#root);
      case "DELETE":
        return await del(request, this.#root);
      case "SUBSCRIBE":
        return await subscribe(request, {
          root: this.#root,
          subscriber: this.#subscriber,
          metaTouch: !!this.args["meta-touch"],
        });
      case "EDITOR":
        return await editor(request, {
          root: this.#root,
          editor: this.args["open-in-editor"],
        });
      default:
        return new Response(`Unknown method: ${method}`, {
          status: 405,
          statusText: "Method Not Allowed",
          headers: {
            "Content-Type": "text/plain",
          },
        });
    }
  };

  #isAuthorized = (request: Request): boolean => {
    const { username, password } = this.args;
    if (!(username || password)) {
      return true;
    }

    const auth = request.headers.get("authorization");
    const [user, pass] = auth?.match("Basic (.*)")?.[1]?.split(":") ?? [];
    return user == username && pass == password;
  };

  async #logResponsePairIfPossible(request: Request, responsePromise: Promise<Response>) {
    if (!this.args.debug) {
      return;
    }

    const maybeResponse = await Promise.race([responsePromise, delay(100)]);

    const requestLog = getRequestLog(request, { verbose: this.args.verbose });
    if (maybeResponse instanceof Response) {
      const responseLog = await getResponseLog(maybeResponse, { verbose: this.args.verbose });
      console.debug(`${requestLog}${this.args.verbose ? "\n" : " -> "}${responseLog}`);
    } else {
      const requestId = this.#lastRequestId++;
      console.debug(`${requestLog} -> (pending: ${requestId})`);
      const response = await responsePromise;
      const responseLog = await getResponseLog(response, { verbose: this.args.verbose });
      console.debug(`${getRequestLog(request, {})} (pending: ${requestId}) -> ${responseLog}`);
    }
  }
}

function getRequestLog(request: Request, { verbose }: { verbose?: boolean }) {
  if (!verbose) {
    return `${request.method} ${request.url}`;
  }

  const log = [`${request.method} ${request.url}`];
  request.headers.forEach((v, k) => {
    if (
      k.match(
        /accept|connection|content-type|dnt|host|origin|sec-|user-agent/i,
      )
    ) {
      return;
    }
    log.push(`${k}: ${v}`);
  });
  return log.join("\n");
}

async function getResponseLog(response: Response, { verbose }: { verbose?: boolean }) {
  const log = [`${response.status} ${response.statusText}`];
  if (!verbose) {
    return log.join("\n");
  }

  response.headers.forEach((v, k) => {
    log.push(`${k}: ${v}`);
  });
  log.push("");

  const text = await response.clone().text();
  log.push(text);

  return log.join("\n");
}
