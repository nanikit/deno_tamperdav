import { DavServer } from "./src/dav_server.ts";
import { join } from "./src/deps.ts";

if (import.meta.main) {
  main();
}

export async function main() {
  // early parsing for the config option
  const optionConfig = Deno.args.reduce(
    (a, c) => c.split("--config=")[1] || a,
    "",
  );
  const config = optionConfig || "config.json";
  const args = await readConfigFile(config);

  for (const k of ["username", "password"]) {
    args[k] = args[k] || Deno.env.get("TD_" + k.toUpperCase());
  }

  for (const val of Deno.args) {
    const s = val.replace(/^[-]{1,2}/, "").split("=");
    args[s[0]] = s[1] || true;
  }

  if (Deno.args.includes("--help")) {
    printHelp();
  }

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
        return new Response(`${error}`);
      },
    },
    new DavServer(root, args).logAndHandleRequest,
  );
  console.log(`server is listening on ${port}`);
  return server;
}

async function readConfigFile(config: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await Deno.readTextFile(config));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) {
      console.error(`${config}: ${err.message}`);
      Deno.exit(1);
    }
  }
  return {};
}

function printHelp() {
  const { os } = Deno.build;
  console.log(
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
  Deno.exit(0);
}
