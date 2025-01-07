import fs from "fs";
import readline from "readline";

export default async function* messagesFromInputFile(path: string): AsyncGenerator<Record<string, unknown>> {
  const fileStream = fs.createReadStream(path);
  const readlineInterface = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of readlineInterface) {
    try {
      const item: unknown = JSON.parse(line);
      if (typeof item === "object") {
        yield item as Record<string, unknown>;
      } else {
        console.warn(`skipping: ${line}`);
      }
    } catch {
      console.warn(`skipping: ${line}`);
    }
  }
}
