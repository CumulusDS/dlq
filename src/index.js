// @flow
// Command Line Interface generator for Dead Letter Queues

import mergeRace from "@async-generator/merge-race";
import path from "path";
import parseArgs from "minimist";
import AWS from "aws-sdk";
import { promises as fsp } from "fs";
import cliProgress from "cli-progress";
import generateSqsMessages from "./generate-sqs-messages";
import aimd from "./aimd";
import generateFileMessages from "./generate-file-messages";

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
      "\t$awsudo -u sts-prod yarn --silent dlq --region us-east-2 --function-name MyService-prod-myFunction --redrive\n"
  );
}

function decodeSqsArn(arn) {
  const [, , , , QueueOwnerAWSAccountId, QueueName] = arn.split(":");
  return { QueueOwnerAWSAccountId, QueueName };
}

async function getQueueUrl(sqs, arn) {
  const { QueueOwnerAWSAccountId, QueueName } = decodeSqsArn(arn);
  const { QueueUrl } = await sqs.getQueueUrl({ QueueName, QueueOwnerAWSAccountId }).promise();
  return QueueUrl;
}

async function getLambdaConfiguration(lambda, sqs, FunctionName) {
  const {
    Configuration: {
      Timeout,
      DeadLetterConfig: { TargetArn }
    }
  } = await lambda.getFunction({ FunctionName }).promise();
  const QueueUrl = await getQueueUrl(sqs, TargetArn);
  return { Timeout, QueueUrl };
}

async function getSqsConfiguration(sqs, QueueUrl) {
  const { Attributes } = await sqs
    .getQueueAttributes({
      QueueUrl,
      AttributeNames: ["RedrivePolicy"]
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
  region?: string,
  drain?: boolean,
  rate?: number,
  redrive?: boolean,
  fun?: string,
  queue?: string,
  space?: string,
  time?: string,
  log?: string,
  fromFile?: string,
  invertedMatch?: string
};

async function redriveMessageToLambda(
  // $FlowFixMe
  message: any,
  lambda: AWS.Lambda,
  sqs: AWS.SQS,
  FunctionName: string,
  QueueUrl: string,
  log: string
) {
  const InvocationType = log == null ? "Event" : "RequestResponse";
  const LogType = log == null ? "None" : "Tail";
  const result = await lambda.invoke({ FunctionName, InvocationType, LogType, Payload: message.Body }).promise();
  if (result.StatusCode === 200) {
    await fsp.writeFile(
      `${log}${message.MessageId}.log`,
      Buffer.concat([
        Buffer.from(`${message.MessageId}\n${result.FunctionError ?? "Success"}\n${result.Payload ?? ""}\n`, "utf-8"),
        Buffer.from(result.LogResult, "base64")
      ])
    );
    if (result.FunctionError == null) {
      await sqs.deleteMessage({ QueueUrl, ReceiptHandle: message.ReceiptHandle }).promise();
    }
  } else if (result.StatusCode === 202) {
    await sqs.deleteMessage({ QueueUrl, ReceiptHandle: message.ReceiptHandle }).promise();
  } else {
    console.error(result);
  }
}

// $FlowFixMe
async function redriveMessageToSqs(message: any, sqs: AWS.SQS, QueueUrl: string, primaryQueue: ?string, log: ?string) {
  const result = await sqs
    .sendMessage({
      MessageBody: message.Body,
      QueueUrl: primaryQueue,
      MessageAttributes: message.MessageAttributes
    })
    .promise();
  if (log != null) {
    await fsp.writeFile(`${log}${message.MessageId}.log`, `Redrive\n${result.MessageId}`);
  }
  await sqs.deleteMessage({ QueueUrl, ReceiptHandle: message.ReceiptHandle }).promise();
}

async function redriveMessage(
  // $FlowFixMe
  message: any,
  lambda: AWS.Lambda,
  sqs: AWS.SQS,
  queueUrl: string,
  functionName: ?string,
  log: string,
  primaryQueue: ?string
) {
  if (functionName != null) {
    await redriveMessageToLambda(message, lambda, sqs, functionName, queueUrl, log);
  } else {
    await redriveMessageToSqs(message, sqs, queueUrl, primaryQueue, log);
  }
}

function parallelGenerateSqsMessage(sqs: AWS.SQS, params: AWS.SQS.Types.ReceiveMessageRequest, n: number) {
  const generators = [];
  for (let i = 0; i < n; i += 1) {
    generators.push(generateSqsMessages(sqs, params));
  }
  return mergeRace(...generators);
}

export default async function(options: Options) {
  function handleMessage(space, redrive, lambda, sqs, QueueUrl, FunctionName, log, primaryQueue, drain) {
    // flowlint-next-line unclear-type:off
    return async (message: Object) => {
      console.log(JSON.stringify({ ...message, skipped: false }, null, parseInt(space, 10)));
      if (redrive) {
        await redriveMessage(message, lambda, sqs, QueueUrl, FunctionName, log, primaryQueue);
      } else if (drain) {
        await sqs.deleteMessage({ QueueUrl, ReceiptHandle: message.ReceiptHandle }).promise();
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
        help: ["h"]
      },
      boolean: ["drain", "redrive"]
    });

    const rate = Number(args.rate ?? options.rate ?? 10) / 1000;
    const region = args.region ?? options.region;
    const drain = args.drain ?? options.drain ?? false;
    const redrive = args.redrive ?? options.redrive ?? false;
    const FunctionName = args.fun ?? options.fun;
    const space = args.space ?? options.space ?? "0";
    const time = Number(args.time ?? options.time ?? "1000");
    const log = args.log ?? options.log;
    const primaryQueue = args.queue ?? options.queue;
    const fromFile = args.fromFile ?? options.fromFile;
    const invertedMatch = args.invertedMatch ?? options.invertedMatch;
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
    const { Timeout, QueueUrl } =
      FunctionName != null
        ? await getLambdaConfiguration(new AWS.Lambda({ region }), sqs, FunctionName)
        : await getSqsConfiguration(sqs, primaryQueue);
    const lambda = new AWS.Lambda({ region, httpOptions: { timeout: Timeout * 1000 + 1000 } });

    // Deadline for starting invocation
    const VisibilityTimeout = time - Timeout;
    const Deadline = now.getTime() + VisibilityTimeout * 1000;

    const promises = [];

    const messages =
      fromFile == null
        ? parallelGenerateSqsMessage(
            sqs,
            {
              QueueUrl,
              MaxNumberOfMessages,
              Deadline,
              VisibilityTimeout
            },
            64
          )
        : await generateFileMessages(fromFile);

    if (log) {
      // $FlowFixMe
      await fsp.mkdir(path.dirname(`${log}x`), { recursive: true });
    }
    const progress = new cliProgress.SingleBar({
      format: "Progress | {bar} | {value}/{total} |  actual {actualRate}/s | target {rate}/s",
      barCompleteChar: "\u2588",
      barIncompleteChar: "\u2591",
      hideCursor: true
    });
    let total = 0;
    const control = aimd({ a: rate / 20, b: 0.5, w: rate, deadline: Deadline });
    const handler = handleMessage(space, redrive, lambda, sqs, QueueUrl, FunctionName, log, primaryQueue, drain);
    progress.start(1, 0, { rate: rate * 1000, actualRate: 0 });
    const start = Date.now();
    for await (const message of messages) {
      if (invertedMatch && JSON.stringify(message).includes(invertedMatch)) {
        console.log(JSON.stringify({ ...message, skipped: true }, null, parseInt(space, 10)));
        promises.push(
          sqs
            .deleteMessage({ QueueUrl, ReceiptHandle: message.ReceiptHandle })
            .promise()
            // eslint-disable-next-line no-loop-func
            .then(() => {
              const elapsed = (Date.now() - start) / 1000;
              progress.increment({ actualRate: (total / elapsed).toFixed(1) });
            })
        );
      } else {
        promises.push(
          // eslint-disable-next-line no-loop-func
          control(async (w: number) => {
            await handler(message);
            const elapsed = (Date.now() - start) / 1000;
            progress.increment({ rate: (w * 1000).toFixed(1), actualRate: (total / elapsed).toFixed(1) });
          })
        );
      }
      total += 1;
      progress.setTotal(total);
    }
    await Promise.all(promises);
    progress.stop();
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
