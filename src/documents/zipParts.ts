import { open } from "node:fs/promises";
import { Inflate } from "fflate";

// The parts of a zip that are read, and only those. Office files (.xlsx,
// .pptx, .ods, .odp) are zips whose text sits in a few XML parts beside
// pictures and videos that are never needed: the central directory says
// where each part is, so a part is read from the file where it lies and
// inflated a slice at a time, up to a cap. A presentation heavy with
// photos is read like a light one, and an enormous sheet stops where its
// cap says, without the whole of it in memory first.

export class ZipError extends Error {
  constructor(
    /// "not_a_zip": no zip directory (an Office file protected by a
    /// password is a different kind of container, see `protectedOffice`).
    readonly reason: "not_a_zip" | "encrypted" | "unsupported_compression" | "corrupt",
  ) {
    super(reason === "not_a_zip" ? "not a zip file" : reason === "encrypted" ? "the file is protected by a password" : reason === "unsupported_compression" ? "unsupported compression" : "the file is damaged");
  }
}

interface Entry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

interface Source {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/// Inflated a slice at a time: 16 KB of deflate never gives more than
/// about 16 MB, whatever the file says.
const SLICE = 16 * 1024;
const MAX_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 200_000;

export class ZipParts {
  private readonly entries = new Map<string, Entry>();

  private constructor(private readonly source: Source, entries: Entry[]) {
    // Part names are compared without case, as Office does.
    for (const entry of entries) this.entries.set(entry.name.replace(/^\/+/, "").toLowerCase(), entry);
  }

  static async open(path: string): Promise<ZipParts> {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      const source: Source = {
        size,
        async read(offset, length) {
          const buffer = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
          let done = 0;
          while (done < buffer.length) {
            const { bytesRead } = await handle.read(buffer, done, buffer.length - done, offset + done);
            if (bytesRead === 0) break;
            done += bytesRead;
          }
          return done === buffer.length ? buffer : buffer.subarray(0, done);
        },
        close: () => handle.close(),
      };
      return new ZipParts(source, await readDirectory(source));
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  static async fromBytes(bytes: Uint8Array): Promise<ZipParts> {
    const source: Source = {
      size: bytes.length,
      read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
      close: async () => undefined,
    };
    return new ZipParts(source, await readDirectory(source));
  }

  close(): Promise<void> {
    return this.source.close();
  }

  has(name: string): boolean {
    return this.entries.has(name.replace(/^\/+/, "").toLowerCase());
  }

  /// The names of the parts, as the zip spells them.
  names(): string[] {
    return [...this.entries.values()].map((entry) => entry.name);
  }

  /// A part's text, at most `maxBytes` of it; `truncated` when it was
  /// longer. Null when the zip has no such part.
  async text(name: string, maxBytes: number): Promise<{ text: string; truncated: boolean } | null> {
    let text = "";
    const outcome = await this.stream(name, maxBytes, (chunk) => {
      text += chunk;
    });
    return outcome === null ? null : { text, truncated: outcome.truncated };
  }

  /// A part's text, handed over a piece at a time as it is inflated, until
  /// `onText` returns false or `maxBytes` were given. Null when the zip
  /// has no such part.
  async stream(name: string, maxBytes: number, onText: (text: string) => boolean | void): Promise<{ truncated: boolean; stopped: boolean } | null> {
    const entry = this.entries.get(name.replace(/^\/+/, "").toLowerCase());
    if (!entry) return null;
    if (entry.flags & 1) throw new ZipError("encrypted");
    if (entry.method !== 0 && entry.method !== 8) throw new ZipError("unsupported_compression");

    const header = await this.source.read(entry.localOffset, 30);
    if (header.length < 30 || u32(header, 0) !== 0x04034b50) throw new ZipError("corrupt");
    const start = entry.localOffset + 30 + u16(header, 26) + u16(header, 28);
    if (start + entry.compressedSize > this.source.size) throw new ZipError("corrupt");

    const decoder = new TextDecoder("utf-8");
    let given = 0;
    let stopped = false;
    let truncated = false;
    const give = (bytes: Uint8Array, final: boolean) => {
      if (stopped || truncated) return;
      let piece = bytes;
      if (given + piece.length > maxBytes) {
        piece = piece.subarray(0, Math.max(0, maxBytes - given));
        truncated = true;
      }
      given += piece.length;
      const text = decoder.decode(piece, { stream: !(final || truncated) });
      if (text && onText(text) === false) stopped = true;
    };

    if (entry.method === 0) {
      for (let at = 0; at < entry.compressedSize && !stopped && !truncated; at += 1024 * 1024) {
        const length = Math.min(1024 * 1024, entry.compressedSize - at);
        give(await this.source.read(start + at, length), at + length >= entry.compressedSize);
      }
      return { truncated, stopped };
    }

    let finished = false;
    const inflate = new Inflate((data, final) => {
      give(data, final);
      if (final) finished = true;
    });
    // Read ahead in larger blocks, inflated in small slices.
    const BLOCK = 1024 * 1024;
    try {
      for (let at = 0; at < entry.compressedSize && !stopped && !truncated && !finished; at += BLOCK) {
        const block = await this.source.read(start + at, Math.min(BLOCK, entry.compressedSize - at));
        for (let offset = 0; offset < block.length && !stopped && !truncated && !finished; offset += SLICE) {
          const last = at + offset + SLICE >= entry.compressedSize;
          inflate.push(block.subarray(offset, offset + SLICE), last);
        }
      }
    } catch (error) {
      if (error instanceof ZipError) throw error;
      throw new ZipError("corrupt");
    }
    return { truncated, stopped };
  }
}

/// The first bytes of an Office file protected by a password, or of a
/// .doc/.xls/.ppt from before 2007: a « compound file », not a zip.
export function compoundFile(head: Uint8Array): boolean {
  return head.length >= 8 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0 && head[4] === 0xa1 && head[5] === 0xb1 && head[6] === 0x1a && head[7] === 0xe1;
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

function u64(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) + u32(bytes, at + 4) * 2 ** 32;
}

async function readDirectory(source: Source): Promise<Entry[]> {
  // The end record is in the last 22 bytes, or before a comment of up to 64 KB.
  const tailLength = Math.min(source.size, 22 + 0xffff);
  const tail = await source.read(source.size - tailLength, tailLength);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (u32(tail, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    if (compoundFile(await source.read(0, 8))) throw new ZipError("encrypted");
    throw new ZipError("not_a_zip");
  }
  let count = u16(tail, end + 10);
  let directorySize = u32(tail, end + 12);
  let directoryOffset = u32(tail, end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    // Zip64: the locator just before the end record says where its own is.
    const locatorAt = source.size - tailLength + end - 20;
    const locator = locatorAt >= 0 ? await source.read(locatorAt, 20) : new Uint8Array();
    if (locator.length === 20 && u32(locator, 0) === 0x07064b50) {
      const record = await source.read(u64(locator, 8), 56);
      if (record.length === 56 && u32(record, 0) === 0x06064b50) {
        count = u64(record, 32);
        directorySize = u64(record, 40);
        directoryOffset = u64(record, 48);
      }
    }
  }
  if (directorySize > MAX_DIRECTORY_BYTES || count > MAX_ENTRIES || directoryOffset + directorySize > source.size) throw new ZipError("corrupt");

  const directory = await source.read(directoryOffset, directorySize);
  const names = new TextDecoder("utf-8");
  const entries: Entry[] = [];
  let at = 0;
  for (let i = 0; i < count && at + 46 <= directory.length; i += 1) {
    if (u32(directory, at) !== 0x02014b50) throw new ZipError("corrupt");
    const nameLength = u16(directory, at + 28);
    const extraLength = u16(directory, at + 30);
    const commentLength = u16(directory, at + 32);
    const entry: Entry = {
      name: names.decode(directory.subarray(at + 46, at + 46 + nameLength)),
      flags: u16(directory, at + 8),
      method: u16(directory, at + 10),
      compressedSize: u32(directory, at + 20),
      size: u32(directory, at + 24),
      localOffset: u32(directory, at + 42),
    };
    // Zip64 sizes and offset, in that order, for the fields set to all ones.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = u16(directory, extra);
      const length = u16(directory, extra + 2);
      if (id === 0x0001) {
        let field = extra + 4;
        const fieldEnd = field + length;
        if (entry.size === 0xffffffff && field + 8 <= fieldEnd) {
          entry.size = u64(directory, field);
          field += 8;
        }
        if (entry.compressedSize === 0xffffffff && field + 8 <= fieldEnd) {
          entry.compressedSize = u64(directory, field);
          field += 8;
        }
        if (entry.localOffset === 0xffffffff && field + 8 <= fieldEnd) entry.localOffset = u64(directory, field);
      }
      extra += 4 + length;
    }
    entries.push(entry);
    at = extraEnd + commentLength;
  }
  return entries;
}
