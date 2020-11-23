// @flow

import AWS from "aws-sdk";
import receiveMessage from "./receive-message";

export default async function* generateSqsMessages(
  sqs: AWS.SQS,
  params: AWS.SQS.Types.ReceiveMessageRequest
): AsyncIterator<AWS.SQS.Message> {
  let messages = await receiveMessage(sqs, params);
  while (messages != null && messages.length > 0) {
    yield* messages;

    // eslint-disable-next-line no-await-in-loop
    messages = await receiveMessage(sqs, params);
  }
}
