// @flow

import fs from "fs";
import readline from "readline";

// flowlint-next-line unclear-type:off
export default async function* messagesFromInputFile(path: string): AsyncIterator<Object> {
  const fileStream = fs.createReadStream(path);
  const readlineInterface = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of readlineInterface) {
    try {
      const item = JSON.parse(line);
      if (typeof item === "object") {
        yield item;
      } else {
        console.warn(`skipping: ${line}`);
      }
    } catch (e) {
      console.warn(`skipping: ${line}`);
    }
  }
}
