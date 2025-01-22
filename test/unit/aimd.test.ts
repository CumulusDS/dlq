import aimd, { Timeout } from "../../src/aimd";

describe("aimd", () => {
  let dateNowSpy: jest.SpyInstance;

  beforeAll(() => {
    const now = 1000000000000;
    dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterAll(() => {
    dateNowSpy.mockRestore();
  });

  it("invokes", () => {
    const fun = jest.fn().mockReturnValueOnce(Promise.resolve(1)).mockReturnValueOnce(Promise.resolve(2));
    return expect(aimd({ a: 0.1, b: 0.5, w: 0.01, deadline: Date.now() + 1000 })(fun)).resolves.toBe(1);
  });

  it("times out if deadline would pass", async () => {
    const fun = jest.fn().mockReturnValueOnce(Promise.resolve(1)).mockReturnValueOnce(Promise.resolve(2));
    const controller = aimd({ a: 0.01, b: 0.5, w: 0.01, deadline: Date.now() + 49 });
    await controller(fun);
    return expect(controller(fun)).rejects.toThrow(Timeout);
  });

  it("continues if deadline would not pass", async () => {
    const fun = jest.fn().mockReturnValueOnce(Promise.resolve(1)).mockReturnValueOnce(Promise.resolve(2));
    const controller = aimd({ a: 0.01, b: 0.5, w: 0.01, deadline: Date.now() + 51 });
    await controller(fun);
    return expect(controller(fun)).resolves.toBe(2);
  });

  it("decreases rate on failure, timing out", async () => {
    const error = new Error("test");
    const fun = jest.fn().mockReturnValueOnce(Promise.reject(error)).mockReturnValueOnce(Promise.resolve(2));
    const controller = aimd({ a: 0.01, b: 0.5, w: 0.01, deadline: Date.now() + 199 });
    return expect(controller(fun)).rejects.toThrow(error);
  });

  it("decreases rate on failure, retrying", async () => {
    const fun = jest
      .fn()
      .mockReturnValueOnce(Promise.reject(new Error("test")))
      .mockReturnValueOnce(Promise.resolve(2));
    const controller = aimd({ a: 0.01, b: 0.5, w: 0.01, deadline: Date.now() + 201 });
    return expect(controller(fun)).resolves.toBe(2);
  });
});
