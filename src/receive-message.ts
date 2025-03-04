import AWS from "aws-sdk";

export default async function receiveMessage(
  sqs: AWS.SQS,
  params: AWS.SQS.Types.ReceiveMessageRequest,
): Promise<AWS.SQS.Types.MessageList> {
  const { Messages } = await sqs.receiveMessage(params).promise();
  return Messages ?? [];
}
