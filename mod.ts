import { parseArgs } from "jsr:@std/cli/parse-args";
import { DavServer } from "./src/dav_server.ts";
import { join } from "./src/deps.ts";

if (import.meta.main) {
  main();
}

export async function main() {
  // early parsing for the config option
  const cliArgs = parseArgs(Deno.args, {
    boolean: ["help", "no-auth-warning", "meta-touch", "debug"],
    string: ["config", "path", "open-in-editor", "host", "port", "username", "password"],
  });

  if (cliArgs.help) {
    printHelp();
    return;
  }

  const config = cliArgs.config || "config.json";
  const fileConfig = await readConfigFile(config);
  const args = Object.assign({}, fileConfig, cliArgs);

  args.username ??= Deno.env.get("TD_USERNAME");
  args.password ??= Deno.env.get("TD_PASSWORD");

  if (!args.path) {
    console.error("path arguments missing");
    Deno.exit(1);
  }

  const root = join(".", args.path as string);
  await Deno.mkdir(root, { recursive: true });

  if (!args["no-auth-warning"] && (!args.username || !args.password)) {
    console.warn(
      "TamperDAV is running without any form of authentication. It's strongly recommended to configure username and password!",
    );
  }

  const port = Number(args.port || 7000);
  const server = Deno.serve(
    {
      hostname: (args.host as string) || "localhost",
      port: port,
      onError: (error) => {
        console.error(error);
        return new Response(`${error}`, { status: 500 });
      },
    },
    new DavServer(root, args).logAndHandleRequest,
  );

  console.info(`server is listening on ${port}`);
  return server;
}

async function readConfigFile(config: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await Deno.readTextFile(config));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error(`${config}: ${error}`);
      Deno.exit(1);
    }
  }
  return {};
}

function printHelp() {
  const { os } = Deno.build;
  console.info(
    `Usage: ${os === "windows" ? "TamperDAV.bat" : "./tamperdav.sh"} [options]
Starts a WebDAV server for Tampermonkey to sync scripts with.

Options:
        --help                     Shows this information
        --config=[path]            Uses the specified config file (default: config.json)
        --no-auth-warning          Disables the warning regarding missing authentication due
                                   to missing username and password
        --meta-touch               Updates corresponding meta file upon changing a script
                                   file, resulting in connected browsers syncing these changes
        --debug                    Provides some more detailed output for debugging purposes
        --open-in-editor=[editor]  The editor to use when pressing the cloud editor icon in
                                   Tampermonkey
        --open-in-editor           Same as above, but uses ${
      os === "windows" ? "notepad.exe" : "the editor chosen by xdg-open"
    }
        --username=[username]      The username for clients to authenticate to the server with
        --password=[password]      The password for clients to authenticate to the server with
        --host=[host]              The network address to bind on (default: localhost)
        --port=[port]              The port that the server will listen on (default: 7000)
        --path=[path]              The path, relativePath to server.js, that will serve as storage

All of these options except "--help" can be specified in a JSON formatted file config.json
in the same directory as server.js. An example is:
{
    "path": "dav",
    "meta-touch": true,
    "username": "foo",
    "password": "bar",
    "port": 1234
}

Options provided as command line parameters all have precedence over options stored in the
config file.

Username and password can also be specified in the environment variables TD_USERNAME and
TD_PASSWORD respectively. These have priority over over the config file, but not over the
command line parameters.
`,
  );
}
