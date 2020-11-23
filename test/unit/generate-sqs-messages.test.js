// @flow

import generateSqsMessages from "../../src/generate-sqs-messages";

describe("generateSqsMessages", () => {
  let dateNowSpy;

  beforeAll(() => {
    const now = 1000000000000;
    dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  const sqs = {
    receiveMessage: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Messages: [{}] }) })
  };

  it("continues when deadline has not passed", () => {
    const Deadline = Date.now() + 1000;
    const generator = generateSqsMessages(sqs, { Deadline });
    return expect(generator.next()).resolves.toMatchObject({ done: false });
  });

  it("stops when deadline has passed", () => {
    const Deadline = Date.now() - 1000;
    const generator = generateSqsMessages(sqs, { Deadline });
    return expect(generator.next()).resolves.toMatchObject({ done: true });
  });

  afterAll(() => {
    dateNowSpy.mockRestore();
  });
});
