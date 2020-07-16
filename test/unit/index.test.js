// @flow

import minimist from "minimist";
import AWS from "aws-sdk";
import { promises as fs } from "fs";
import main from "../../src";

jest.mock("minimist");
jest.mock("fs", () => ({ promises: { writeFile: jest.fn().mockResolvedValue() } }));

jest.mock("aws-sdk");

describe("main", () => {
  let exit: JestMockFn<any, any>; // flowlint-line unclear-type:off

  // SQS mocks
  const deleteMessage = jest.fn(() => ({ promise: jest.fn() }));
  const getQueueAttributes = jest.fn(() => ({
    promise: jest.fn().mockResolvedValue({
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:MyService-prod-MyQueue"
        })
      }
    })
  }));
  const getQueueUrl = jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ QueueUrl: "queue" }) }));
  let sendMessage: JestMockFn<any, any>; // flowlint-line unclear-type:off
  let receiveMessage: JestMockFn<any, any>; // flowlint-line unclear-type:off
  let SQS: JestMockFn<any, any>; // flowlint-line unclear-type:off

  // Lambda mocks
  let invoke: JestMockFn<any, any>; // flowlint-line unclear-type:off
  let Lambda: JestMockFn<any, any>; // flowlint-line unclear-type:off

  beforeEach(() => {
    exit = jest.spyOn(process, "exit").mockImplementation(() => {});

    invoke = jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ StatusCode: 202 }) }));
    Lambda = jest.fn(() => ({
      invoke,
      getFunction: jest.fn(() => ({
        promise: jest.fn().mockResolvedValue({
          Configuration: {
            DeadLetterConfig: { TargetArn: "target-arn" }
          }
        })
      }))
    }));
    AWS.Lambda = Lambda;

    sendMessage = jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ MessageId: "987" }) }));
    const promise = jest
      .fn()
      .mockResolvedValueOnce({
        Messages: [{ ReceiptHandle: "receipt-handle", MessageId: "123", MessageAttributes: {}, Body: "{}" }]
      })
      // $FlowFixMe
      .mockResolvedValueOnce({});
    receiveMessage = jest.fn(() => ({
      promise
    }));
    SQS = jest.fn(() => ({
      receiveMessage,
      getQueueUrl,
      deleteMessage,
      getQueueAttributes,
      sendMessage
    }));
    AWS.SQS = SQS;
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

  describe("with function name", () => {
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
          Payload: "{}"
        });
      });

      it("deletes message", async () => {
        await main({});
        const sqs = new AWS.SQS();
        expect(sqs.deleteMessage).toBeCalledWith({ QueueUrl: "queue", ReceiptHandle: "receipt-handle" });
      });

      describe("with AWS invocation status code 400", () => {
        beforeEach(() => {
          invoke.mockImplementation(() => ({ promise: jest.fn().mockResolvedValue({ StatusCode: 400 }) }));
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
      beforeEach(() => {
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
        receiveMessage.mockImplementation(() => ({
          promise: jest.fn().mockRejectedValue(new Error("sqs.receiveMessage failed"))
        }));
      });

      it("has error exit status", async () => {
        await main({});
        expect(exit).toBeCalledWith(2);
      });
    });
  });

  describe("with queue url", () => {
    const region = "us-east-1";
    const queue = "https://sqs.us-east-1.amazonaws.com/000000000000/MyService-prod-MyQueue";
    beforeEach(() => {
      // $FlowFixMe
      minimist.mockImplementation(() => ({ region, queue }));
    });

    it("calls getQueueAttributes", async () => {
      await main({});
      const sqs = new AWS.SQS();
      expect(sqs.getQueueAttributes).toBeCalledWith({
        AttributeNames: ["RedrivePolicy"],
        QueueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/MyService-prod-MyQueue"
      });
    });

    it("completes normally", async () => {
      await main({});
      expect(exit).toBeCalledWith(0);
    });

    describe("redriving", () => {
      beforeEach(() => {
        // $FlowFixMe
        minimist.mockImplementation(() => ({ region, queue, redrive: true }));
      });

      it("calls sendMessage", async () => {
        await main({});
        const sqs = new AWS.SQS();
        expect(sqs.sendMessage).toBeCalledWith({
          MessageAttributes: {},
          MessageBody: "{}",
          QueueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/MyService-prod-MyQueue"
        });
      });

      describe("logging", () => {
        beforeEach(() => {
          // $FlowFixMe
          minimist.mockImplementation(() => ({ region, queue, redrive: true, log: "prefix-" }));
        });

        it("writes a log file", async () => {
          await main({});
          expect(fs.writeFile).toBeCalledWith("prefix-123.log", "Redrive\n987");
        });
      });
    });

    describe("without Redrive Policy", () => {
      beforeEach(() => {
        getQueueAttributes.mockImplementation(() => ({
          promise: jest.fn().mockResolvedValue({})
        }));
      });
      it("has error exit status", async () => {
        await main({});
        expect(exit).toBeCalledWith(2);
      });
    });

    describe("without dead letter target", () => {
      beforeEach(() => {
        getQueueAttributes.mockImplementation(() => ({
          promise: jest.fn().mockResolvedValue({
            Attributes: {
              RedrivePolicy: JSON.stringify({})
            }
          })
        }));
      });
      it("has error exit status", async () => {
        await main({});
        expect(exit).toBeCalledWith(2);
      });
    });
  });
});
