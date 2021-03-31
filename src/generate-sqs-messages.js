// @flow

import AWS from "aws-sdk";
import receiveMessage from "./receive-message";

export type Params = {|
  ...AWS.SQS.Types.ReceiveMessageRequest,
  Deadline: Date
|};

export default async function* generateSqsMessages(
  sqs: AWS.SQS,
  params: AWS.SQS.Types.ReceiveMessageRequest
): AsyncIterator<AWS.SQS.Message> {
  const { Deadline, ...sqsParams } = params;

  async function receive() {
    const now = Date.now();
    if (Deadline < now) return null;
    const WaitTimeSeconds = Math.min(20, (Deadline - now) / 1000);
    return receiveMessage(sqs, { ...sqsParams, WaitTimeSeconds });
  }

  let messages = await receive();

  while (messages != null && messages.length > 0) {
    yield* messages;
    messages = await receive();
  }
}
