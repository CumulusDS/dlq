import util from "util";

const setTimeoutPromise = util.promisify(setTimeout);

type Params = {
  // Additive factor (invocations per millisecond) for increasing function issue rate upon success
  a: number;
  // Multiplicative factor for decreasing function issue rate upon error
  b: number;
  // Initial function issue rate (invocations per millisecond)
  w: number;
  // Retry until deadline (milliseconds since epoch) would be exceeded
  deadline: number;
};

export class Timeout extends Error {
  code = "Timeout";

  constructor() {
    super("Timeout");
  }
}

// Return a thunk that invokes the given async function rate-limited using additive increase/multiplicative decrease congestion control. If the given function throws, then the thunk retries it until the deadline would be exceeded.
export default function aimd(params: Params) {
  const { a, b, deadline } = params;
  let { w } = params;
  let n = 0;
  const start = Date.now();

  return async function invoke<T>(fun: (arg: number) => Promise<T>): Promise<T> {
    let now = Date.now();
    let elapsed = now - start;
    let target = elapsed * w;
    let shortfall = n - target;
    let delay = shortfall / w;
    while (now + delay < deadline) {
      n += 1;
      if (delay > 0) {
        await setTimeoutPromise(delay);
      }
      try {
        const result = await fun(w);
        w += a;
        return result;
      } catch (err: unknown) {
        w *= b;
        now = Date.now();
        elapsed = now - start;
        target = elapsed * w;
        shortfall = n - target;
        delay = shortfall / w;
        if (deadline <= now + delay) {
          console.error("Stopping after error.", (err as Error).message);
          throw err;
        }
        console.error("Retrying after error.", (err as Error).message);
      }
    }
    throw new Timeout();
  };
}
