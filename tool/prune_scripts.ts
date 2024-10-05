import { parseArgs } from "jsr:@std/cli/parse-args";
import { basename, dirname, join } from "jsr:@std/path";

if (import.meta.main) {
  main();
}

async function main() {
  const { delete: $delete, help, move, _: rest } = parseArgs(Deno.args, {
    alias: { "d": "delete", "h": "help", "m": "move" },
    string: ["move"],
    boolean: ["delete", "help"],
  });

  const directory = rest[0] as string;
  if (help || !directory) {
    console.log(`Usage: deno run -A prune_scripts.ts [options] [directory]
Options:
  -d, --delete           Delete unused scripts
  -h, --help             Show this help
  -m, --move <directory> Move unused scripts to specified directory

If no options are specified, unused scripts are listed.`);
    return;
  }

  const files = await getUnusedFiles(directory);
  if ($delete) {
    await Promise.all(files.map(removeAnyway));
  } else if (move) {
    await Deno.mkdir(move, { recursive: true });
    await Promise.all(files.map((file) => Deno.rename(file, join(move, basename(file)))));
  } else {
    console.log(files.join("\n"));
  }
}

export async function pruneScripts(directory: string) {
  const files = await getUnusedFiles(directory);
  await Promise.all(files.map(removeAnyway));
}

async function getUnusedFiles(directory: string) {
  const metaFiles = [] as string[];
  const jsFiles = [] as string[];

  for await (const item of Deno.readDir(directory)) {
    if (!item.isFile) {
      continue;
    }

    if (item.name.endsWith(".meta.json")) {
      metaFiles.push(item.name);
    } else if (item.name.endsWith(".user.js")) {
      jsFiles.push(item.name);
    }
  }

  const orphanMetaAndRemovedOnes = await Promise.all(
    metaFiles.map((file) => getOrphanMetaAndRemoved(directory, file, jsFiles)),
  );
  return [
    ...orphanMetaAndRemovedOnes.flat().flat(),
    ...jsFiles.map((file) => join(directory, file)),
  ];
}

async function getOrphanMetaAndRemoved(directory: string, metaFile: string, jsFiles: string[]) {
  const metaPath = join(directory, metaFile);
  const metaJson = await Deno.readTextFile(metaPath);
  const meta = JSON.parse(metaJson);
  const jsFile = `${meta.uuid}.user.js`;

  if (!jsFiles.includes(jsFile)) {
    return [metaPath];
  }

  jsFiles.splice(jsFiles.indexOf(jsFile), 1);
  if (meta.options?.removed) {
    const jsPath = join(dirname(metaPath), jsFile);
    return [metaPath, jsPath];
  }

  return [];
}

async function removeAnyway(path: string) {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
}
