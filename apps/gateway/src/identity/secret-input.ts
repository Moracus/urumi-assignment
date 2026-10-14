import { open } from "node:fs/promises";
import { stdin, stdout } from "node:process";

// Strip only a mounted text file's final line ending, preserving password spaces.
export async function readSecretFile(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error("Secret file too large");
    return buffer.subarray(0, bytesRead).toString("utf8").replace(/\r?\n$/, "");
  } finally { await file.close(); }
}

export async function hiddenPrompt(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Use mounted secret files without a terminal");
  stdout.write(label);
  const previousRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(previousRaw);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003" || character === "\u0004") { finish(new Error("Input cancelled")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") value = Array.from(value).slice(0, -1).join("");
        else value += character;
        if (Buffer.byteLength(value) > 4096) { finish(new Error("Input too large")); return; }
      }
    };
    stdin.on("data", onData);
  });
}
