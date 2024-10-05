import { zip } from "jsr:@std/collections/zip";
import { toFileUrl } from "jsr:@std/path/to-file-url";

export async function arrayToXml(
  { root, files, cursor }: {
    root: string;
    files: string[];
    cursor?: number;
  },
) {
  const stats = await Promise.all(files.map((file) => Deno.stat(file).catch(() => null)));
  const rootUrl = `${toFileUrl(root)}`;
  const relatives = files.map((file) => {
    return `${toFileUrl(file)}`.slice(rootUrl.length) || "/";
  });
  const xmls = zip(relatives, stats).map(([relative, stat]) => buildItemXml(relative, stat));

  const new_cursor = cursor ? `<td:cursor>${cursor}</td:cursor>` : "";
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:td="http://dav.tampermonkey.net/ns">${
    xmls.join("\n")
  }${new_cursor}</d:multistatus>`;
}

function buildItemXml(subPath: string, stat: Deno.FileInfo | null) {
  const mtime = new Date(stat?.mtime || Date.now());
  const size = stat?.size ?? -1;
  const lastModified = mtime.toISOString();
  const isDirectory = stat?.isDirectory ?? false;

  return [
    "<d:response>",
    `<d:href>${subPath}</d:href>`,
    "<d:propstat>",
    "<d:prop>",
    `<d:getlastmodified>${lastModified}</d:getlastmodified>`,
    isDirectory ? "<d:resourcetype><d:collection/></d:resourcetype>" : "<d:resourcetype />",
    !isDirectory ? `<d:getcontentlength>${size}</d:getcontentlength>` : "<d:getcontentlength />",
    "</d:prop>",
    "<d:status>HTTP/1.1 200 OK</d:status>",
    "</d:propstat>",
    "</d:response>",
  ]
    .join("\n");
}
