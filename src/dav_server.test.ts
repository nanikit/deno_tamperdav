import { delay } from "jsr:@std/async/delay";
import { assertEquals, assertStringIncludes } from "../tool/deps.ts";
import { DavServer } from "./dav_server.ts";
import { join } from "./deps.ts";

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

Deno.test("Given a server and subscription", async (test) => {
  const root = await Deno.makeTempDir();
  const file = join(root, "test.txt");
  await Deno.writeTextFile(file, "Hello, world!");

  const handler = new DavServer(root, {});
  const server = Deno.serve({ port: 0 }, handler.logAndHandleRequest);
  const { port } = server.addr;

  await test.step("when change a file", async (test) => {
    const responsePromise = fetch(`http://localhost:${port}/`, { method: "SUBSCRIBE" });
    await delay(800);
    await Deno.writeTextFile(file, "Can I really use shebang in js?");
    const response = await responsePromise;

    await test.step("should return 207", () => {
      assertEquals(response.status, 207);
    });

    await test.step("should contain the file", async () => {
      const xml = await response.text();
      assertStringIncludes(xml, "<d:href>/test.txt</d:href>");
    });
  });

  // await test.step("when change files rapidly", async (test) => {
  //   const responsePromise = fetch(`http://localhost:${port}/`, { method: "SUBSCRIBE" });
  //   await delay(50);
  //   await Deno.writeTextFile(join(root, "test1.txt"), "May I help you?");
  //   await delay(50);
  //   await Deno.writeTextFile(join(root, "test2.txt"), "Can I really use shebang in js?");
  //   await delay(50);
  //   await Deno.writeTextFile(join(root, "test3.txt"), "Can I really use shebang in js?");
  //   await delay(50);
  //   await Deno.writeTextFile(join(root, "test4.txt"), "Can I really use shebang in js?");
  //   await delay(50);
  //   const response = await responsePromise;

  //   await test.step("should return 207", () => {
  //     assertEquals(response.status, 207);
  //   });

  //   await test.step("should collect all changes", async () => {
  //     const xml = await response.text();
  //     assertStringIncludes(xml, "<d:href>/test1.txt</d:href>");
  //     assertStringIncludes(xml, "<d:href>/test2.txt</d:href>");
  //     assertStringIncludes(xml, "<d:href>/test3.txt</d:href>");
  //     assertStringIncludes(xml, "<d:href>/test4.txt</d:href>");
  //   });
  // });

  await server.shutdown();
  await Deno.remove(root, { recursive: true });
});
