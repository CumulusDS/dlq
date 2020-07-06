// @flow
// Command Line Interface generator for Dead Letter Queues

import parseArgs from "minimist";
import AWS from "aws-sdk";

function printHelp() {
  console.log(
    "Download the Historian dead letters\n\n" +
      "Options:\n" +
      "\t-d DRAIN, --drain (true|false) - Print and delete messages\n" +
      "\t-R REDRIVE, --redrive (true|false) - Print, redrive and delete messages\n" +
      "\t-S SPACE, --space NUMBER - Pretty print with N spaces\n" +
      "\n" +
      "\t-r REGION, --region STRING - Specify the AWS region to address\n" +
      "\t-f FUNCTION, --function-name STRING - The name of the Lambda function, version, or alias\n" +
      "\n" +
      "\t-h, --help - Print this message.\n" +
      "\n" +
      "\n" +
      "\tMessages will be printed as concatenated JSON. Each message is one line, unless the --space option is given.\n" +
      "\tNote that --redrive can get stuck in an infinite loop, endlessly redriving, if the events are failing.\n" +
      "\tExample:\n" +
      "\t$awsudo -u sts-prod yarn --silent dlq --region us-east-2 --function-name StsHistorian-prod-workCompletionMessageReceived --redrive\n"
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
  space?: string
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
        help: ["h"]
      },
      boolean: ["drain", "redrive"]
    });

    const region = args.region ?? options.region;
    const drain = args.drain ?? options.drain ?? false;
    const redrive = args.redrive ?? options.redrive ?? false;
    const FunctionName = args.fun ?? options.fun;
    const space = args.space ?? options.space ?? "0";
    if (args.help || typeof region !== "string" || typeof FunctionName !== "string") {
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
        // eslint-disable-next-line no-loop-func
        messages.forEach(async message => {
          console.log(JSON.stringify(message, null, parseInt(space, 10)));
          if (redrive) {
            const result = await lambda
              .invoke({ FunctionName, InvocationType: "Event", Payload: message.Body })
              .promise();
            if (result.StatusCode < 300) {
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
