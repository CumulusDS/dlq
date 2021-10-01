// @flow

import minimist from "minimist";
import AWS from "aws-sdk";
import { promises as fs, createReadStream } from "fs";
import readline from "readline";
import main from "../../src";

jest.mock("minimist");
jest.mock("fs", () => ({
  promises: { writeFile: jest.fn().mockResolvedValue(), mkdir: jest.fn() },
  createReadStream: jest.fn()
}));
jest.mock("readline");
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
  let getFunction: JestMockFn<any, any>; // flowlint-line unclear-type:off

  beforeEach(() => {
    exit = jest.spyOn(process, "exit").mockImplementation(() => {});

    invoke = jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ StatusCode: 202 }) }));
    getFunction = jest.fn(() => ({
      promise: jest.fn().mockResolvedValue({
        Configuration: {
          DeadLetterConfig: { TargetArn: "target-arn" },
          Timeout: 6
        }
      })
    }));
    Lambda = jest.fn(() => ({
      invoke,
      getFunction
    }));
    AWS.Lambda = Lambda;

    sendMessage = jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ MessageId: "987" }) }));
    const promise = jest
      .fn()
      .mockResolvedValueOnce({
        Messages: [{ ReceiptHandle: "receipt-handle", MessageId: "123", MessageAttributes: {}, Body: "{}" }]
      })
      // $FlowFixMe
      .mockResolvedValue({});
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
                  DeadLetterConfig: { TargetArn: "target-arn" },
                  Timeout: 6
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
                    DeadLetterConfig: { TargetArn: "target-arn" },
                    Timeout: 6
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
        getFunction.mockImplementation(() => ({
          promise: jest.fn().mockRejectedValue(new Error("failed"))
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
        getQueueAttributes.mockImplementationOnce(() => ({
          promise: jest.fn().mockResolvedValueOnce({})
        }));
      });
      it("has error exit status", async () => {
        await main({});
        expect(exit).toBeCalledWith(2);
      });
    });

    describe("without dead letter target", () => {
      beforeEach(() => {
        getQueueAttributes.mockImplementationOnce(() => ({
          promise: jest.fn().mockResolvedValueOnce({
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

  describe("with from file", () => {
    const region = "us-east-1";
    const queue = "https://sqs.us-east-1.amazonaws.com/000000000000/MyService-prod-MyQueue";
    const fromFile = "file://log";

    describe("redrive", () => {
      beforeEach(() => {
        // $FlowFixMe
        minimist.mockImplementation(() => ({ region, queue, fromFile, redrive: true }));
        // $FlowFixMe
        readline.createInterface = jest.fn().mockReturnValue([
          Promise.resolve(
            JSON.stringify({
              MessageId: "1",
              ReceiptHandle: "r1",
              Body: "Hello World",
              MessageAttributes: {}
            })
          ),
          Promise.resolve(
            JSON.stringify({
              MessageId: "2",
              ReceiptHandle: "r2",
              Body: "Hello World 2",
              MessageAttributes: {}
            })
          ),
          Promise.resolve(
            JSON.stringify({
              MessageId: "3",
              ReceiptHandle: "r3",
              Body: "Goodbye World",
              MessageAttributes: {}
            })
          )
        ]);
        getQueueAttributes.mockImplementationOnce(() => ({
          promise: jest.fn().mockResolvedValueOnce({
            Attributes: {
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: "arn:aws:sqs:us-east-1:000000000000:MyService-prod-MyQueue"
              })
            }
          })
        }));
      });

      it("should read file stream without blocking thread", async () => {
        await main({});
        const sqs = new AWS.SQS();
        expect(createReadStream).toHaveBeenCalledWith("file://log");
        expect(sqs.receiveMessage).not.toHaveBeenCalled();
        expect(sqs.sendMessage).toHaveBeenNthCalledWith(1, {
          MessageAttributes: {},
          MessageBody: "Hello World",
          QueueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/MyService-prod-MyQueue"
        });
        expect(sqs.sendMessage).toHaveBeenNthCalledWith(2, {
          MessageAttributes: {},
          MessageBody: "Hello World 2",
          QueueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/MyService-prod-MyQueue"
        });
        expect(sqs.sendMessage).toHaveBeenNthCalledWith(3, {
          MessageAttributes: {},
          MessageBody: "Goodbye World",
          QueueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/MyService-prod-MyQueue"
        });
      });
    });
  });
});
