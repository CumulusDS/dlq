import { SQSClient, Message, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type { ReceiveMessageCommandInput, ReceiveMessageCommandOutput } from "@aws-sdk/client-sqs";
// import receiveMessage from "./receive-message";
import { Params } from "./types";

export default async function* generateSqsMessages(sqs: SQSClient, params: Params): AsyncGenerator<Message> {
  const { Deadline, ...sqsParams } = params;

  async function receive() {
    const now = Date.now();
    if (Deadline < now) return null;
    const WaitTimeSeconds = Math.min(20, (Deadline - now) / 1000);

    const ReceiveMessageCmdInput: ReceiveMessageCommandInput = { ...sqsParams, WaitTimeSeconds };
    const command: ReceiveMessageCommand = new ReceiveMessageCommand(ReceiveMessageCmdInput);
    const result: ReceiveMessageCommandOutput = await sqs.send(command);
    const { Messages } = result;
    return Messages;
    // return receiveMessage(sqs, { ...sqsParams, WaitTimeSeconds });
  }

  let messages = await receive();

  while (messages != null && messages.length > 0) {
    yield* messages;
    messages = await receive();
  }
}
