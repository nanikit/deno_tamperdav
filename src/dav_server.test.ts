import { deadline } from "jsr:@std/async/deadline";
import { delay } from "jsr:@std/async/delay";
import { join } from "jsr:@std/path";
import { assertEquals, assertStringIncludes } from "../tool/deps.ts";
import { DavServer } from "./dav_server.ts";

Deno.test("Given a server with files", async (test) => {
  const root = await Deno.makeTempDir();
  const file = join(root, "test.txt");
  await Deno.writeTextFile(file, "Hello, world!");
  await Deno.mkdir(join(root, "Tampermonkey/sync"), { recursive: true });
  await Deno.writeTextFile(`${root}/Tampermonkey/sync/test2.js`, "Hello, script!");

  const handler = new DavServer(root, {});
  const server = Deno.serve({ port: 0 }, handler.logAndHandleRequest);
  const { port } = server.addr;

  await test.step("when PROPFIND", async (test) => {
    const response = await fetch(`http://localhost:${port}/`, { method: "PROPFIND" });

    await test.step("should return 207", () => {
      assertEquals(response.status, 207);
    });

    await test.step("should contain files", async () => {
      const xml = await response.text();
      assertStringIncludes(xml, "<d:href>/test.txt</d:href>");
      assertStringIncludes(xml, "<d:href>/Tampermonkey/sync/test2.js</d:href>");
    });
  });

  await server.shutdown();
  await Deno.remove(root, { recursive: true });
});

Deno.test("Given fresh server", async (test) => {
  const root = await Deno.makeTempDir();
  const file = join(root, "test.txt");
  await Deno.writeTextFile(file, "Hello, world!");

  using handler = new DavServer(root, {});
  const server = Deno.serve({ port: 0 }, handler.logAndHandleRequest);
  const { port } = server.addr;

  await test.step("when subscribe 4 times", async (test) => {
    const responses = await deadline(
      Promise.all([
        fetch(`http://localhost:${port}/`, { method: "SUBSCRIBE" }),
        fetch(`http://localhost:${port}/`, { method: "SUBSCRIBE" }),
        fetch(`http://localhost:${port}/`, { method: "SUBSCRIBE" }),
        fetch(`http://localhost:${port}/`, { method: "SUBSCRIBE" }),
      ]),
      1000,
    );

    await test.step("should return all 204", () => {
      assertEquals(responses.map((x) => x.status), [204, 204, 204, 204]);
    });
  });

  await test.step("when change a file", async (test) => {
    const responsePromise = fetch(`http://localhost:${port}/`, { method: "SUBSCRIBE" });
    await delay(800);
    await Deno.writeTextFile(file, "Can I really use shebang in js?");
    const response = await deadline(responsePromise, 1000);

    await test.step("should return 207", () => {
      assertEquals(response.status, 207);
    });

    await test.step("should contain the file", async () => {
      const xml = await response.text();
      assertStringIncludes(xml, "<d:href>/test.txt</d:href>");
    });
  });

  await server.shutdown();
  await Deno.remove(root, { recursive: true });
});
