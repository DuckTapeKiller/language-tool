/** A file inside a ZIP archive, such as the thesaurus inside LibreOffice's «es.oxt» */
export async function extractZipEntry(zip: Uint8Array, name: string): Promise<Uint8Array> {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // The end of the central directory sits in the last 64 KB, after an optional comment
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            end = i;
            break;
        }
    }
    if (end < 0) throw new Error("Not a ZIP archive");

    const decoder = new TextDecoder();
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    for (let n = 0; n < count; n++) {
        if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Damaged ZIP archive");
        const method = view.getUint16(at + 10, true);
        const size = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const local = view.getUint32(at + 42, true);
        if (decoder.decode(zip.subarray(at + 46, at + 46 + nameLength)) === name) {
            const start =
                local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
            const data = zip.subarray(start, start + size);
            if (method === 0) return data.slice();
            if (method === 8) return inflateRaw(data);
            throw new Error(`${name} is compressed in a way this cannot read`);
        }
        at += 46 + nameLength + extraLength + commentLength;
    }
    throw new Error(`${name} is not in the archive`);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data.slice()])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
