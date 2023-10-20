import { join } from "./deps.ts";

export async function arrayToXml(
  { root, relativePath, files, cursor }: {
    root: string;
    relativePath: string;
    files: string[];
    cursor?: number;
  },
) {
  const fpath = join(root, relativePath);

  const xmls = await Promise.all(files.map(buildItemXml));
  const new_cursor = cursor ? `<td:cursor>${cursor}</td:cursor>` : "";
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:td="http://dav.tampermonkey.net/ns">${
    xmls.join(
      "\n",
    )
  }${new_cursor}</d:multistatus>`;

  async function buildItemXml(file: string) {
    const name = file;
    const canonicalPath = join(fpath, name);

    let stats, dir;
    try {
      stats = await Deno.stat(canonicalPath);
      dir = stats.isDirectory;
    } catch (_e) {
      stats = {
        mtime: Date.now(),
        size: -1,
      };
      dir = false;
    }

    const mtime = new Date(stats.mtime || Date.now());
    const size = stats.size;
    const lastModified = mtime.toUTCString();

    return [
      "<d:response>",
      `<d:href>${join(relativePath, name)}</d:href>`,
      "<d:propstat>",
      "<d:prop>",
      `<d:getlastmodified>${lastModified}</d:getlastmodified>`,
      dir ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype />",
      !dir ? `<d:getcontentlength>${size}</d:getcontentlength>` : "<d:getcontentlength />",
      "</d:prop>",
      "<d:status>HTTP/1.1 200 OK</d:status>",
      "</d:propstat>",
      "</d:response>",
    ]
      .filter(function (e) {
        return e;
      })
      .join("\n");
  }
}
