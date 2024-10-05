import { resolve } from "jsr:@std/path";
import { returnsNext, stub } from "jsr:@std/testing/mock";
import { FakeTime } from "jsr:@std/testing/time";
import { assertEquals } from "../tool/deps.ts";
import { FsSubscriber, toSubscription } from "./subscription_handler.ts";

Deno.test("Given plain request", async (test) => {
  const request = new Request(`http://localhost:8000/`);

  await test.step("when parse", async (test) => {
    const subscription = toSubscription(request);

    await test.step("path should be '.'", () => {
      assertEquals(subscription.path, ".");
    });

    await test.step("depth should be 0", () => {
      assertEquals(subscription.depth, 0);
    });

    await test.step("timeout should be 60", () => {
      assertEquals(subscription.timeoutSeconds, 60);
    });
  });
});

Deno.test("Given custom request", async (test) => {
  const path = "/Tampermonkey/sync/";
  const request = new Request(`http://localhost:8000${path}`, {
    headers: {
      "authorization": "Basic Og==",
      "content-type": "text/xml; charset=UTF-8",
      "depth": "1",
      "timeout": "90",
    },
  });

  await test.step("when parse", async (test) => {
    const subscription = toSubscription(request);

    await test.step("path should be 'Tampermonkey/sync'", () => {
      assertEquals(subscription.path, "Tampermonkey/sync");
    });

    await test.step("depth should be 1", () => {
      assertEquals(subscription.depth, 1);
    });

    await test.step("timeout should be 90", () => {
      assertEquals(subscription.timeoutSeconds, 90);
    });
  });
});

Deno.test("Given a subscription", async (test) => {
  const time = new FakeTime();
  using subscriber = new FsSubscriber(".");
  const response = subscriber.subscribe({
    path: "test",
    timeoutSeconds: 90,
    depth: 1,
    signal: new AbortController().signal,
  });

  let result: Set<string> | null = null;
  response.then((value) => {
    result = value;
  });

  await test.step("after 89s", async (test) => {
    time.tick(89 * 1000);
    await time.runMicrotasks();

    await test.step("result should be pending", () => {
      assertEquals(result, null);
    });
  });

  await test.step("after 90s", async (test) => {
    time.tick(1 * 1000);
    await time.runMicrotasks();

    await test.step("result should be empty", () => {
      assertEquals(result, new Set());
    });
  });

  time.restore();
});

Deno.test("When subscribe 'test' directory", async (test) => {
  const time = new FakeTime();
  const watcherMock = new MockFsWatcher();

  let watchPath: string | null = null;
  const stubbed = stub(Deno, "watchFs", (path) => {
    watchPath = path as string;
    return watcherMock;
  });

  let result: Set<string> | null = null;

  using subscriber = new FsSubscriber(".");
  subscriber.subscribe({
    path: "test",
    timeoutSeconds: 90,
    depth: 1,
    signal: new AbortController().signal,
  }).then((value) => result = value);

  await test.step("watch path should be './test'", () => {
    assertEquals(watchPath, resolve("test"));
  });

  await test.step("if 'test-not-equal/file' is created", async (test) => {
    watcherMock.feed({
      kind: "create",
      flag: null as unknown as undefined,
      paths: [resolve("test-not-equal", "file")],
    });
    await time.runMicrotasks();
    time.tick(90 * 1000);
    await time.runMicrotasks();

    await test.step("it should return empty", () => {
      assertEquals(result, new Set([]));
    });
  });

  stubbed.restore();
  time.restore();
});

Deno.test("Given a directory", async (test) => {
  const time = new FakeTime();
  const watcherMock = new MockFsWatcher();
  const stubbed = stub(Deno, "watchFs", returnsNext([watcherMock]));

  using subscriber = new FsSubscriber(".");

  await test.step("after 500ms from file creation", async (test) => {
    let result: Set<string> | null = null;

    subscriber.subscribe({
      path: "test",
      timeoutSeconds: 90,
      depth: 1,
      signal: new AbortController().signal,
    }).then((value) => result = value);

    watcherMock.feed({
      kind: "create",
      flag: null as unknown as undefined,
      paths: [resolve("test", "file")],
    });
    await time.runMicrotasks();
    time.tick(500);
    await time.runMicrotasks();

    await test.step("it should return the file", () => {
      assertEquals(result, new Set(["test/file"]));
    });
  });

  await test.step("when create more file and resubscribe", async (test) => {
    let result: Set<string> | null = null;

    watcherMock.feed({
      kind: "create",
      paths: [resolve("test", "file2")],
    });
    await time.runMicrotasks();

    time.tick(400);
    subscriber.subscribe({
      path: "test",
      timeoutSeconds: 90,
      depth: 1,
      signal: new AbortController().signal,
    }).then((value) => result = value);
    await time.runMicrotasks();

    time.tick(100);
    await time.runMicrotasks();

    await test.step("result should contain the file", () => {
      assertEquals(result, new Set(["test/file2"]));
    });
  });

  stubbed.restore();
  time.restore();
});

class MockFsWatcher implements Deno.FsWatcher {
  #resolver = Promise.withResolvers<Deno.FsEvent>();

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Deno.FsEvent> {
    while (true) {
      yield this.#resolver.promise;
    }
  }

  feed(event: Deno.FsEvent) {
    this.#resolver.resolve(event);
    this.#resolver = Promise.withResolvers<Deno.FsEvent>();
  }

  close = () => {};
  [Symbol.dispose] = this.close;
}
