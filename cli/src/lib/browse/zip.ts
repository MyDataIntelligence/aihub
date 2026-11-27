import { inflateRawSync } from "node:zlib";

/**
 * Just enough of the zip format for a run artifact (Azure DevOps hands every artifact out as a zip): the list of files
 * from the central directory and one file read out. Store and deflate only; zip64 archives are refused with a sentence.
 */

export interface ZipEntry {
  path: string;
  bytes: number;
  compressedBytes: number;
  method: number;
  offset: number;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

export function zipEntries(buf: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("this artifact is a zip64 archive; download it instead");
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== CEN) throw new Error("the zip's file list is damaged");
    const method = buf.readUInt16LE(at + 10);
    const compressedBytes = buf.readUInt32LE(at + 20);
    const bytes = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const path = buf.toString("utf8", at + 46, at + 46 + nameLen);
    if (!path.endsWith("/")) out.push({ path, bytes, compressedBytes, method, offset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipRead(buf: Buffer, e: ZipEntry): Buffer {
  if (buf.readUInt32LE(e.offset) !== LOC) throw new Error(`the zip entry ${e.path} is damaged`);
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.compressedBytes);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return inflateRawSync(data);
  throw new Error(`the zip entry ${e.path} uses compression method ${e.method}`);
}
