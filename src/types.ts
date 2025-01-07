import AWS from "aws-sdk";

export type Params = AWS.SQS.Types.ReceiveMessageRequest & {
  Deadline: number;
};
