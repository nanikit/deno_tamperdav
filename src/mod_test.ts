import { join } from "https://deno.land/std@0.203.0/path/mod.ts";

Deno.test("Given file watcher", async (test) => {
  const temp1 = await Deno.makeTempDir();
  const temp2 = await Deno.makeTempDir();
  const originalPath = join(temp1, "test.txt");
  await Deno.writeTextFile(originalPath, "test");
  const linkPath = join(temp2, "link.txt");
  await Deno.symlink(originalPath, linkPath);
  const watcher = Deno.watchFs(originalPath);

  await test.step("when change symbolic link", async (test) => {
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await Deno.writeTextFile(linkPath, "test2");
    })();

    await test.step("it should notify update", async () => {
      for await (const event of watcher) {
        console.log(event);
        break;
      }
    });
  });

  await Deno.remove(temp1, { recursive: true });
  await Deno.remove(temp2, { recursive: true });
});
