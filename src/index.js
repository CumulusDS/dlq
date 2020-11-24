// @flow
// Command Line Interface generator for Dead Letter Queues

import parseArgs from "minimist";
import AWS from "aws-sdk";
import fs, { promises as fsp } from "fs";
import readline from "readline";
import generateSqsMessages from "./generate-sqs-messages";
import aimd from "./aimd";

function printHelp() {
  console.log(
    "Download or reprocess Dead Letters for an AWS Lambda function or SQS\n\n" +
      "Options:\n" +
      "\t-d, --drain              - Print and delete messages\n" +
      "\t-R, --redrive            - Print, redrive and delete messages\n" +
      "\t-l PREFIX, --log PREFIX  - Log redrive output to files with the given prefix\n" +
      "\t-S SPACE, --space NUMBER - Pretty print with N spaces\n" +
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
  redrive?: boolean,
  fun?: string,
  queue?: string,
  space?: string,
  time?: string,
  log?: string,
  fromFile?: string
};

async function messagesFromInputFile(path: string, fn: string => void) {
  const fileStream = fs.createReadStream(path);
  const readlineInterface = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of readlineInterface) {
    fn(line);
  }
}

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

export default async function(options: Options) {
  function handleMessage(space, redrive, lambda, sqs, QueueUrl, FunctionName, log, primaryQueue, drain) {
    return async message => {
      console.log(JSON.stringify(message, null, parseInt(space, 10)));
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
        region: ["r"],
        redrive: ["R"],
        fun: ["f", "function-name"],
        queue: ["q", "queue-url"],
        space: ["S"],
        time: ["t"],
        log: ["l"],
        fromFile: ["i", "from-file"],
        help: ["h"]
      },
      boolean: ["drain", "redrive"]
    });

    const region = args.region ?? options.region;
    const drain = args.drain ?? options.drain ?? false;
    const redrive = args.redrive ?? options.redrive ?? false;
    const FunctionName = args.fun ?? options.fun;
    const space = args.space ?? options.space ?? "0";
    const time = Number(args.time ?? options.time ?? "30");
    const log = args.log ?? options.log;
    const primaryQueue = args.queue ?? options.queue;
    const fromFile = args.fromFile ?? options.fromFile;
    if (
      args.help ||
      typeof region !== "string" ||
      typeof FunctionName === "boolean" ||
      typeof primaryQueue === "boolean" ||
      typeof log === "boolean" ||
      typeof fromFile === "boolean" ||
      (FunctionName == null && primaryQueue == null) ||
      Number.isNaN(time)
    ) {
      printHelp();
      process.exit(1);
      return;
    }
    const MaxNumberOfMessages = 10;
    const lambda = new AWS.Lambda({ region });
    const sqs = new AWS.SQS({ region });
    const now = new Date();
    const { Timeout, QueueUrl } =
      FunctionName != null
        ? await getLambdaConfiguration(lambda, sqs, FunctionName)
        : await getSqsConfiguration(sqs, primaryQueue);

    // Deadline for starting invocation
    const Deadline = new Date(now.getTime() + (time - Timeout) * 1000);

    const promises = [];

    if (fromFile != null) {
      await messagesFromInputFile(fromFile, (message: string) => {
        console.log(message);
        promises.push(redriveMessage(JSON.parse(message), lambda, sqs, QueueUrl, FunctionName, log, primaryQueue));
      });
    } else {
      const rateControl = aimd({ a: 0.05, b: 0.5, w: 0.1, deadline: Deadline.getTime() });
      const handler = handleMessage(space, redrive, lambda, sqs, QueueUrl, FunctionName, log, primaryQueue, drain);
      for await (const message of generateSqsMessages(sqs, { QueueUrl, MaxNumberOfMessages, Deadline })) {
        promises.push(rateControl(() => handler(message)));
      }
    }
    await Promise.all(promises);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
