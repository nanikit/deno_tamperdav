import { assertEquals } from "jsr:@std/assert";
import { copy } from "jsr:@std/fs";
import { basename, join, resolve } from "jsr:@std/path";
import { pruneScripts } from "./prune_scripts.ts";

Deno.test("Given empty directory", async (test) => {
  const clone = await Deno.makeTempDir();

  await test.step("when prune", async (test) => {
    await pruneScripts(clone);

    await test.step("it should be empty", async () => {
      assertEquals(await snapshotDirectory(clone), []);
    });
  });

  await Deno.remove(clone, { recursive: true });
});

Deno.test("Given directory containing directory", async (test) => {
  const original = await Deno.makeTempDir();
  await Deno.mkdir(join(original, "test"));
  const clone = await cloneDirectory(original);

  await test.step("when prune", async (test) => {
    await pruneScripts(clone);

    await test.step("it should be empty", async () => {
      await assertDirectoryEquals(clone, original);
    });
  });

  await Promise.all([
    Deno.remove(original, { recursive: true }),
    Deno.remove(clone, { recursive: true }),
  ]);
});

Deno.test("Given alive meta.json", async (test) => {
  const template = resolve("./test/data/normal_meta");
  const clone = await cloneDirectory(template);

  await test.step("when prune", async (test) => {
    await pruneScripts(clone);

    await test.step("it should preserve all", async () => {
      await assertDirectoryEquals(clone, template);
    });
  });

  await Deno.remove(clone, { recursive: true });
});

Deno.test("Given removed meta.json", async (test) => {
  const template = resolve("./test/data/removed_meta");
  const clone = await cloneDirectory(template);

  await test.step("when prune", async (test) => {
    await pruneScripts(clone);

    await test.step("it should remove all", async () => {
      assertEquals(await snapshotDirectory(clone), []);
    });
  });

  await Deno.remove(clone, { recursive: true });
});

Deno.test("Given removed orphan meta.json", async (test) => {
  const template = resolve("./test/data/removed_orphan_meta");
  const clone = await cloneDirectory(template);

  await test.step("when prune", async (test) => {
    await pruneScripts(clone);

    await test.step("it should remove it", async () => {
      assertEquals(await snapshotDirectory(clone), []);
    });
  });

  await Deno.remove(clone, { recursive: true });
});

Deno.test("Given orphan meta.json", async (test) => {
  const template = resolve("./test/data/orphan_meta");
  const clone = await cloneDirectory(template);

  await test.step("when prune", async (test) => {
    await pruneScripts(clone);

    await test.step("it should remove it", async () => {
      assertEquals(await snapshotDirectory(clone), []);
    });
  });

  await Deno.remove(clone, { recursive: true });
});

Deno.test("Given orphan user.js", async (test) => {
  const template = resolve("./test/data/orphan_js");
  const clone = await cloneDirectory(template);

  await test.step("when prune", async (test) => {
    await pruneScripts(clone);

    await test.step("it should remove it", async () => {
      assertEquals(await snapshotDirectory(clone), []);
    });
  });

  await Deno.remove(clone, { recursive: true });
});

async function cloneDirectory(original: string) {
  const directory = await Deno.makeTempDir({
    dir: resolve("./test/tmp"),
    prefix: basename(original),
  });
  await copy(original, directory, { overwrite: true });
  return directory;
}

async function assertDirectoryEquals(actual: string, expected: string) {
  const [actualFiles, expectedFiles] = await Promise.all([
    snapshotDirectory(actual),
    snapshotDirectory(expected),
  ]);
  assertEquals(actualFiles, expectedFiles);
}

async function snapshotDirectory(actual: string) {
  const entries = await Array.fromAsync(Deno.readDir(actual));

  return await Promise.all(entries.flatMap(async (item) => {
    if (!item.isFile) {
      return [];
    }
    const content = await Deno.readFile(join(actual, item.name));
    return { item, content };
  }));
}
