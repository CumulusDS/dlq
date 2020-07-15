// @flow

import minimist from "minimist";
import AWS from "aws-sdk";
import { promises as fs } from "fs";
import main from "../../src";

jest.mock("minimist");
jest.mock("fs", () => ({ promises: { writeFile: jest.fn().mockResolvedValue() } }));

jest.mock("aws-sdk", () => {
  const deleteMessage = jest.fn(() => ({ promise: jest.fn() }));
  const invoke = jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ StatusCode: 202 }) }));
  const Lambda = jest.fn(() => ({
    invoke,
    getFunction: jest.fn(() => ({
      promise: jest.fn().mockResolvedValue({
        Configuration: {
          DeadLetterConfig: { TargetArn: "target-arn" }
        }
      })
    }))
  }));
  const SQS = jest.fn(() => {
    const receiveMessagePromise = jest
      .fn()
      .mockResolvedValueOnce({ Messages: [{ ReceiptHandle: "receipt-handle", MessageId: "123" }] })
      // $FlowFixMe
      .mockResolvedValueOnce({});
    return {
      receiveMessage: jest.fn(() => ({
        promise: receiveMessagePromise
      })),
      getQueueUrl: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ QueueUrl: "queue" }) })),
      deleteMessage
    };
  });
  return {
    Lambda,
    SQS
  };
});

describe("main", () => {
  let exit: JestMockFn<any, any>; // flowlint-line unclear-type:off
  beforeEach(() => {
    exit = jest.spyOn(process, "exit").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("with no options", () => {
    beforeEach(() => {
      // $FlowFixMe
      minimist.mockImplementation(() => ({}));
    });

    it("prints help message when no arguments are given", async () => {
      await main({});
      expect(exit).toBeCalledWith(1);
    });
  });

  describe("with arguments", () => {
    const region = "us-east-1";
    const fun = "service-stage-function";
    beforeEach(() => {
      // $FlowFixMe
      minimist.mockImplementation(() => ({ region, fun }));
    });

    it("completes normally", async () => {
      await main({});
      expect(exit).toBeCalledWith(0);
    });

    describe("redrive", () => {
      beforeEach(() => {
        // $FlowFixMe
        minimist.mockImplementation(() => ({ region, fun, redrive: true }));
      });

      it("invokes asynchronously", async () => {
        await main({});
        const lambda = new AWS.Lambda();
        expect(lambda.invoke).toBeCalledWith({
          FunctionName: "service-stage-function",
          InvocationType: "Event",
          LogType: "None",
          Payload: undefined
        });
      });

      it("deletes message", async () => {
        await main({});
        const sqs = new AWS.SQS();
        expect(sqs.deleteMessage).toBeCalledWith({ QueueUrl: "queue", ReceiptHandle: "receipt-handle" });
      });

      describe("with AWS invocation status code 400", () => {
        beforeEach(() => {
          AWS.Lambda = jest.fn(() => ({
            invoke: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ StatusCode: 400 }) })),
            getFunction: jest.fn(() => ({
              promise: jest.fn().mockResolvedValue({
                Configuration: {
                  DeadLetterConfig: { TargetArn: "target-arn" }
                }
              })
            }))
          }));
        });

        it("does not delete message", async () => {
          await main({});
          const sqs = new AWS.SQS();
          expect(sqs.deleteMessage).not.toBeCalled();
        });
      });

      describe("log", () => {
        beforeEach(() => {
          // $FlowFixMe
          minimist.mockImplementation(() => ({ region, fun, redrive: true, log: "prefix-" }));

          AWS.Lambda = jest.fn(() => ({
            invoke: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ StatusCode: 200, LogResult: "LOGGED" }) })),
            getFunction: jest.fn(() => ({
              promise: jest.fn().mockResolvedValue({
                Configuration: {
                  DeadLetterConfig: { TargetArn: "target-arn" }
                }
              })
            }))
          }));
        });

        it("writes a log file", async () => {
          await main({});
          expect(fs.writeFile).toBeCalledWith("prefix-123.log", expect.any(Object));
        });

        it("deletes message", async () => {
          await main({});
          const sqs = new AWS.SQS();
          expect(sqs.deleteMessage).toBeCalledWith({ QueueUrl: "queue", ReceiptHandle: "receipt-handle" });
        });

        describe("with Function Error", () => {
          beforeEach(() => {
            AWS.Lambda = jest.fn(() => ({
              invoke: jest.fn(() => ({
                promise: jest
                  .fn()
                  .mockResolvedValue({ StatusCode: 200, LogResult: "LOGGED", FunctionError: "Unhandled" })
              })),
              getFunction: jest.fn(() => ({
                promise: jest.fn().mockResolvedValue({
                  Configuration: {
                    DeadLetterConfig: { TargetArn: "target-arn" }
                  }
                })
              }))
            }));
          });

          it("does not delete message", async () => {
            await main({});
            const sqs = new AWS.SQS();
            expect(sqs.deleteMessage).not.toBeCalled();
          });
        });
      });
    });

    describe("drain", () => {
      beforeEach(async () => {
        // $FlowFixMe
        minimist.mockImplementation(() => ({ region, fun, drain: true }));
      });

      it("deletes message", async () => {
        const sqs = new AWS.SQS();
        await main({});
        expect(sqs.deleteMessage).toBeCalledWith({ QueueUrl: "queue", ReceiptHandle: "receipt-handle" });
      });
    });

    describe("failing", () => {
      beforeEach(() => {
        AWS.SQS = jest.fn(() => ({
          receiveMessage: jest.fn(() => ({
            promise: jest.fn().mockRejectedValue(new Error("sqs.receiveMessage failed"))
          })),
          getQueueUrl: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ QueueUrl: "queue" }) }))
        }));
      });

      it("has error exit status", async () => {
        await main({});
        expect(exit).toBeCalledWith(2);
      });
    });
  });
});
