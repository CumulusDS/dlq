import { SQSClient, Message, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import type {
  ReceiveMessageRequest,
  ReceiveMessageCommandInput,
  ReceiveMessageCommandOutput,
} from "@aws-sdk/client-sqs";

// export default async function receiveMessage(
//   sqs: AWS.SQS,
//   params: AWS.SQS.Types.ReceiveMessageRequest,
// ): Promise<AWS.SQS.Types.MessageList> {
//   const { Messages } = await sqs.receiveMessage(params).promise();
export default async function receiveMessage(sqs: SQSClient, params: ReceiveMessageRequest): Promise<Message[]> {
  const ReceiveMessageCmdInput: ReceiveMessageCommandInput = params;
  const command: ReceiveMessageCommand = new ReceiveMessageCommand(ReceiveMessageCmdInput);
  const result: ReceiveMessageCommandOutput = await sqs.send(command);
  // const { Messages } = await sqs.send(command);
  const { Messages } = result;
  return Messages ?? [];
}
