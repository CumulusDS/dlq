// import { SQS } from "aws-sdk";
import { SQSClient } from "@aws-sdk/client-sqs";
import generateSqsMessages from "../../src/generate-sqs-messages";
import { Params } from "../../src/types";

jest.mock("@aws-sdk/client-sqs", () => {});

describe("generateSqsMessages", () => {
  let dateNowSpy: jest.SpyInstance;

  beforeAll(() => {
    const now = 1000000000000;
    dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  // const sqs = {
  //   receiveMessage: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Messages: [{}] }) }),
  // } as unknown as SQSClient;
  const sqs: SQSClient = new SQSClient({});

  it("continues when deadline has not passed", () => {
    const Deadline = Date.now() + 1000;
    const generator = generateSqsMessages(sqs, { Deadline } as Params);
    return expect(generator.next()).resolves.toMatchObject({ done: false });
  });

  it("stops when deadline has passed", () => {
    const Deadline = Date.now() - 1000;
    const generator = generateSqsMessages(sqs, { Deadline } as Params);
    return expect(generator.next()).resolves.toMatchObject({ done: true });
  });

  afterAll(() => {
    dateNowSpy.mockRestore();
  });
});
