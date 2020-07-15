// @flow
// Command Line Interface generator for Dead Letter Queues

import parseArgs from "minimist";
import AWS from "aws-sdk";
import { promises as fs } from "fs";

function printHelp() {
  console.log(
    "Download or reprocess Dead Letters for an AWS Lambda function\n\n" +
      "Options:\n" +
      "\t-d, --drain              - Print and delete messages\n" +
      "\t-R, --redrive            - Print, redrive and delete messages\n" +
      "\t-l PREFIX, --log PREFIX  - Log redrive output to files with the given prefix\n" +
      "\t-S SPACE, --space NUMBER - Pretty print with N spaces\n" +
      "\n" +
      "\t-r REGION, --region STRING          - Specify the AWS region to address\n" +
      "\t-f FUNCTION, --function-name STRING - The name of the Lambda function, version, or alias\n" +
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

async function receiveMessage(sqs, QueueUrl, MaxNumberOfMessages) {
  const { Messages } = await sqs.receiveMessage({ QueueUrl, MaxNumberOfMessages }).promise();
  return Messages;
}

async function getLambdaDeadLetterConfigurationTargetArn(lambda, FunctionName) {
  const {
    Configuration: {
      DeadLetterConfig: { TargetArn }
    }
  } = await lambda.getFunction({ FunctionName }).promise();
  return TargetArn;
}

async function getLambdaDeadLetterConfigurationTargetUrl(lambda, sqs, FunctionName) {
  const QueueArn = await getLambdaDeadLetterConfigurationTargetArn(lambda, FunctionName);
  const [, , , , QueueOwnerAWSAccountId, QueueName] = QueueArn.split(":");
  const { QueueUrl } = await sqs.getQueueUrl({ QueueName, QueueOwnerAWSAccountId }).promise();
  return QueueUrl;
}

export type Options = {
  region?: string,
  drain?: boolean,
  redrive?: boolean,
  fun?: string,
  space?: string,
  log?: string
};

export default async function(options: Options) {
  try {
    const args = parseArgs(process.argv.slice(2), {
      alias: {
        drain: ["d"],
        region: ["r"],
        redrive: ["R"],
        fun: ["f", "function-name"],
        space: ["S"],
        log: ["l"],
        help: ["h"]
      },
      boolean: ["drain", "redrive"]
    });

    const region = args.region ?? options.region;
    const drain = args.drain ?? options.drain ?? false;
    const redrive = args.redrive ?? options.redrive ?? false;
    const FunctionName = args.fun ?? options.fun;
    const space = args.space ?? options.space ?? "0";
    const log = args.log ?? options.log;
    if (args.help || typeof region !== "string" || typeof FunctionName !== "string" || typeof log === "boolean") {
      printHelp();
      process.exit(1);
      return;
    }
    const MaxNumberOfMessages = 10;
    const lambda = new AWS.Lambda({ region });
    const sqs = new AWS.SQS({ region });
    const QueueUrl = await getLambdaDeadLetterConfigurationTargetUrl(lambda, sqs, FunctionName);
    let messages = await receiveMessage(sqs, QueueUrl, MaxNumberOfMessages);
    const promises = [];
    while (messages != null && messages.length > 0) {
      promises.push(
        ...messages.map(async message => {
          console.log(JSON.stringify(message, null, parseInt(space, 10)));
          if (redrive) {
            const InvocationType = log == null ? "Event" : "RequestResponse";
            const LogType = log == null ? "None" : "Tail";
            const result = await lambda
              .invoke({ FunctionName, InvocationType, LogType, Payload: message.Body })
              .promise();
            if (result.StatusCode === 200) {
              await fs.writeFile(
                `${log}${message.MessageId}.log`,
                Buffer.concat([
                  Buffer.from(
                    `${message.MessageId}\n${result.FunctionError ?? "Success"}\n${result.Payload ?? ""}\n`,
                    "utf-8"
                  ),
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
          } else if (drain) {
            await sqs.deleteMessage({ QueueUrl, ReceiptHandle: message.ReceiptHandle }).promise();
          }
        })
      );
      // eslint-disable-next-line no-await-in-loop
      messages = await receiveMessage(sqs, QueueUrl, MaxNumberOfMessages);
    }
    await Promise.all(promises);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}
