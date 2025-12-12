import type { ReceiveMessageRequest } from "@aws-sdk/client-sqs";

export type Params = ReceiveMessageRequest & {
  Deadline: number;
};
