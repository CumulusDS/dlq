// Command Line Interface generator for Dead Letter Queues

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import mergeRace from "@async-generator/merge-race";
import path from "path";
import parseArgs from "minimist";
import AWS, { Lambda, SQS } from "aws-sdk";
import { promises as fsp } from "fs";
import cliProgress from "cli-progress";
import { GetFunctionResponse } from "aws-sdk/clients/lambda";
import generateSqsMessages from "./generate-sqs-messages";
import aimd from "./aimd";
import generateFileMessages from "./generate-file-messages";
import { Params } from "./types";

function printHelp() {
  console.log(
    "Download or reprocess Dead Letters for an AWS Lambda function or SQS\n\n" +
      "Options:\n" +
      "\t-d, --drain              - Print and delete messages\n" +
      "\t-R, --redrive            - Print, redrive and delete messages\n" +
      "\t-l PREFIX, --log PREFIX  - Log redrive output to files with the given prefix\n" +
      "\t-S SPACE, --space NUMBER - Pretty print with N spaces\n" +
      "\t-v PATTERN, --inverted-match PATTERN - Do not redrive messages with the given pattern\n" +
      "\n" +
      "\t-w RATE, --rate RATE     - Issue the given number of messages per second\n" +
      "\t-t TIME, --time NUMBER   - Run for the given number of seconds\n" +
      "\n" +
      "\t-r REGION, --region STRING          - Specify the AWS region to address\n" +
      "\t-f FUNCTION, --function-name STRING - The name of the Lambda function, version, or alias\n" +
      "\t-q URL, --queue-url URL             - The url of the SQS queue\n" +
      "\t-i FILE, --from-file FILE           - Redrive messages drained to a log file\n" +
      "\n" +
      "\t-h, --help - Print this message.\n" +
      "\n" +
      "\n" +
      "\tThe application prints dead letter messages as concatenated JSON. Each message is one line, unless the --space option is given.\n" +
      "\tUse the --log option with --redrive to use synchronous invocation when redriving the DLQ messages.\n" +
      "\tLogs from failed redrive attempts are written to files with the given prefix.\n" +
      "\tNote that --redrive can get stuck in an infinite loop, endlessly redriving, if the events are failing.\n" +
      "\n" +
      "\tExample:\n" +
      "\t$awsudo -u sts-prod yarn --silent dlq --region us-east-2 --function-name MyService-prod-myFunction --redrive\n",
  );
}

function decodeSqsArn(arn: string) {
  const [, , , , QueueOwnerAWSAccountId, QueueName] = arn.split(":");
  return { QueueOwnerAWSAccountId, QueueName };
}

async function getQueueUrl(sqs: SQS, arn: string) {
  const { QueueOwnerAWSAccountId, QueueName } = decodeSqsArn(arn);
  const { QueueUrl } = await sqs.getQueueUrl({ QueueName, QueueOwnerAWSAccountId }).promise();
  return QueueUrl;
}

async function getLambdaConfiguration(lambda: Lambda, sqs: SQS, FunctionName: string) {
  const funcResponse: GetFunctionResponse = await lambda.getFunction({ FunctionName }).promise();
  if (!funcResponse || !funcResponse.Configuration || !funcResponse.Configuration.DeadLetterConfig?.TargetArn) {
    throw new Error(`No function or DLQ '${FunctionName}'`);
  }
  const {
    Configuration: {
      Timeout,
      DeadLetterConfig: { TargetArn },
    },
  } = funcResponse;
  const QueueUrl = await getQueueUrl(sqs, TargetArn);
  return { Timeout, QueueUrl };
}

async function getSqsConfiguration(sqs: SQS, QueueUrl: string) {
  const { Attributes } = await sqs
    .getQueueAttributes({
      QueueUrl,
      AttributeNames: ["RedrivePolicy"],
    })
    .promise();
  const RedrivePolicy = Attributes?.RedrivePolicy;
  if (RedrivePolicy == null) {
    throw new Error(`No redrive policy on queue '${QueueUrl}'`);
  }
  const { deadLetterTargetArn } = JSON.parse(RedrivePolicy);
  if (deadLetterTargetArn == null) {
    throw new Error(`No dead letter target on queue '${QueueUrl}'`);
  }
  return { Timeout: 0, QueueUrl: await getQueueUrl(sqs, deadLetterTargetArn) };
}

export type Options = {
  region?: string;
  drain?: boolean;
  rate?: number;
  redrive?: boolean;
  fun?: string;
  queue?: string;
  space?: string;
  time?: string;
  log?: string;
  fromFile?: string;
  invertedMatch?: string;
};

async function redriveMessageToLambda(
  message: SQS.Message,
  lambda: AWS.Lambda,
  FunctionName: string,
  log: string | null,
  retireMessage: (arg1: { ReceiptHandle: string }) => Promise<void>,
) {
  const InvocationType = log == null ? "Event" : "RequestResponse";
  const LogType = log == null ? "None" : "Tail";
  const result = await lambda.invoke({ FunctionName, InvocationType, LogType, Payload: message.Body }).promise();
  if (result.StatusCode === 200) {
    await fsp.writeFile(
      `${log}${message.MessageId}.log`,
      Buffer.concat([
        Buffer.from(`${message.MessageId}\n${result.FunctionError ?? "Success"}\n${result.Payload ?? ""}\n`, "utf-8"),
        Buffer.from(result.LogResult ?? "", "base64"),
      ]),
    );
    if (result.FunctionError == null && message.ReceiptHandle) {
      await retireMessage(message as { ReceiptHandle: string });
    }
  } else if (result.StatusCode === 202 && message.ReceiptHandle) {
    await retireMessage(message as { ReceiptHandle: string });
  } else {
    console.error(result);
  }
}

async function redriveMessageToSqs(
  message: SQS.Message & { ReceiptHandle: string },
  sqs: AWS.SQS,
  primaryQueue: string,
  log: string | null | undefined,
  retireMessage: (arg1: { ReceiptHandle: string }) => Promise<void>,
) {
  const result = await sqs
    .sendMessage({
      MessageBody: message.Body ?? "",
      QueueUrl: primaryQueue,
      MessageAttributes: message.MessageAttributes,
    })
    .promise();
  if (log != null) {
    await fsp.writeFile(`${log}${message.MessageId}.log`, `Redrive\n${result.MessageId}`);
  }
  await retireMessage(message);
}

async function redriveMessage(
  message: SQS.Message & { ReceiptHandle: string },
  lambda: AWS.Lambda,
  sqs: AWS.SQS,
  functionName: string | null | undefined,
  log: string | null,
  primaryQueue: string | null,
  retireMessage: (arg1: { ReceiptHandle: string }) => Promise<void>,
) {
  if (functionName != null) {
    await redriveMessageToLambda(message, lambda, functionName, log, retireMessage);
  } else {
    await redriveMessageToSqs(message, sqs, primaryQueue as string, log, retireMessage);
  }
}

function parallelGenerateSqsMessage(sqs: AWS.SQS, params: Params, n: number) {
  const generators = [];
  for (let i = 0; i < n; i += 1) {
    generators.push(generateSqsMessages(sqs, params));
  }
  return mergeRace(...generators);
}

// eslint-disable-next-line func-names
export default async function (options: Options): Promise<void> {
  function handleMessage(
    space: string,
    redrive: boolean,
    lambda: Lambda,
    sqs: SQS,
    FunctionName: string | null,
    log: string | null,
    primaryQueue: string | null,
    drain: boolean,
    retireMessage: (arg1: { ReceiptHandle: string }) => Promise<void>,
  ) {
    return async (message: SQS.Message & { ReceiptHandle: string }) => {
      console.log(JSON.stringify({ ...message, skipped: false }, null, parseInt(space, 10)));
      if (redrive) {
        await redriveMessage(message, lambda, sqs, FunctionName, log, primaryQueue, retireMessage);
      } else if (drain) {
        await retireMessage(message);
      }
    };
  }

  try {
    const args = parseArgs(process.argv.slice(2), {
      alias: {
        drain: ["d"],
        rate: ["w"],
        region: ["r"],
        redrive: ["R"],
        fun: ["f", "function-name"],
        queue: ["q", "queue-url"],
        space: ["S"],
        time: ["t"],
        log: ["l"],
        fromFile: ["i", "from-file"],
        invertedMatch: ["v", "inverted-match"],
        help: ["h"],
      },
      boolean: ["drain", "redrive"],
    });

    const rate = Number(args.rate ?? options.rate ?? 10) / 1000;
    const region: string | null = args.region ?? options.region ?? null;
    const drain: boolean = args.drain ?? Boolean(options.drain) ?? false;
    const redrive: boolean = args.redrive ?? Boolean(options.redrive) ?? false;
    const FunctionName: boolean | string | null = args.fun ?? options.fun ?? null;
    const space: string = args.space ?? options.space ?? "0";
    const time = Number(args.time ?? options.time ?? "1000");
    const log: boolean | string | null = args.log ?? options.log ?? null;
    const primaryQueue: boolean | string | null = args.queue ?? options.queue ?? null;
    const fromFile: boolean | string | null = args.fromFile ?? options.fromFile ?? null;
    const invertedMatch: boolean | string | null = args.invertedMatch ?? options.invertedMatch ?? null;
    if (
      args.help ||
      typeof region !== "string" ||
      typeof FunctionName === "boolean" ||
      typeof primaryQueue === "boolean" ||
      typeof log === "boolean" ||
      typeof fromFile === "boolean" ||
      (FunctionName == null && primaryQueue == null) ||
      Number.isNaN(time) ||
      typeof invertedMatch === "boolean"
    ) {
      printHelp();
      process.exit(1);
      return;
    }

    const MaxNumberOfMessages = 10;
    const sqs = new AWS.SQS({ region });
    const now = new Date();
    const { Timeout: TimeoutRaw, QueueUrl } =
      FunctionName != null
        ? await getLambdaConfiguration(new AWS.Lambda({ region }), sqs, FunctionName)
        : await getSqsConfiguration(sqs, primaryQueue as string);
    if (!QueueUrl) {
      // noinspection ExceptionCaughtLocallyJS
      throw new Error("No queue url");
    }

    const Timeout = TimeoutRaw ?? 10;
    const lambda = new AWS.Lambda({ region, httpOptions: { timeout: Timeout * 1000 + 1000 } });

    // Deadline for starting invocation
    const VisibilityTimeout = time + Timeout;
    const Deadline = now.getTime() + time * 1000;

    const promises = [];

    const messages =
      fromFile == null
        ? parallelGenerateSqsMessage(
            sqs,
            {
              QueueUrl,
              MaxNumberOfMessages,
              Deadline,
              VisibilityTimeout,
            },
            32,
          )
        : generateFileMessages(fromFile);

    const noop = () => Promise.resolve();
    const retireSqsMessage = async (message: SQS.Message & { ReceiptHandle: string }): Promise<void> => {
      await sqs.deleteMessage({ QueueUrl, ReceiptHandle: message.ReceiptHandle }).promise();
    };

    const retireMessage: (arg1: SQS.Message & { ReceiptHandle: string }) => Promise<void> =
      fromFile == null ? retireSqsMessage : noop;

    if (log) {
      await fsp.mkdir(path.dirname(`${log}`), { recursive: true });
    }
    const progress = new cliProgress.SingleBar({
      format: "Progress | {bar} | {value}/{total} |  actual {actualRate}/s | target {rate}/s",
      barCompleteChar: "\u2588",
      barIncompleteChar: "\u2591",
      hideCursor: true,
    });
    let total = 0;
    const control = aimd({ a: rate / 20, b: 0.5, w: rate, deadline: Deadline });
    const handler = handleMessage(space, redrive, lambda, sqs, FunctionName, log, primaryQueue, drain, retireMessage);
    progress.start(1, 0, { rate: rate * 1000, actualRate: 0 });
    const start = Date.now();
    for await (const message of messages) {
      if (invertedMatch && JSON.stringify(message).includes(invertedMatch)) {
        console.log(JSON.stringify({ ...message, skipped: true }, null, parseInt(space, 10)));
        promises.push(
          retireMessage(message.ReceiptHandle)
            // eslint-disable-next-line no-loop-func
            .then(() => {
              const elapsed = (Date.now() - start) / 1000;
              progress.increment({ actualRate: (total / elapsed).toFixed(1) });
            }),
        );
      } else {
        promises.push(
          // eslint-disable-next-line no-loop-func
          control(async (w: number) => {
            await handler(message);
            const elapsed = (Date.now() - start) / 1000;
            progress.increment({ rate: (w * 1000).toFixed(1), actualRate: (total / elapsed).toFixed(1) });
          }),
        );
      }
      total += 1;
      progress.setTotal(total);
    }
    await Promise.all(promises);
    progress.stop();
    process.exit(0);
  } catch (e: unknown) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
