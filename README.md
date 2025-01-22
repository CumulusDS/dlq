# DLQ

Maybe you have an AWS SQS or asynchronously triggered Lambda Function with a Dead Letter Queue (DLQ) configured to catch errors. Good! You are demonstrating forethought and a good architecture. Perhaps something happened, and now you now have some messages in your DLQ. It happens to the best of us. Maybe your customers are calling you, wanting to make sure that their messages are not dead. And now you are scratching your head wondering what to do.

This package provides a CLI tool to manipulate a AWS Dead Letter Queue attached to a Lambda Function, or an SQS Queues. The utility is helpful to solve moderate goofs, up to maybe a million events (depending on how much of a hurry you are in). Probably you need to find a different approach if you need to handle a zillion events. I hope that reprocessing your events isn't too expensive.

## Usage

The dlq utility downloads messages from a Dead Letter Queue attached to either an AWS Lambda function or a primary SQS. The messages are loaded through the PC running the DLQ utility. This offers flexibility with processing the messages, but limits the scalability for large sets of messages. Several parallel SQS loading streams are used to improve throughput.

It goes without saying that you should practice using this tool in a staging environment before applying it to production data. It might not be suitable for your configuration.

### Show messages

```
npx -q @cumulusds/dlq --region us-east-1 --function-name MyService-dev-aggregator
```

The command echos each JSON message on a separate line without removing from the queue.

### Redrive messages

```
npx -q @cumulusds/dlq --region us-east-1 --function-name MyService-dev-aggregator --redrive
```

The command invokes the function with each message. Then the command deletes each re-driven message from the queue. The invocation is asynchronous, so if the message fails again, a new DLQ message is created by AWS Lambda.

To synchronously redrive message and collect status and logs, use the `--log PREFIX` option. A file will be created for each invocation. The filename is the prefix given by the `--log PREFIX` argument, appended with the messageID and ".log" file extension. The following command line will redrive Dead Letter Queue messages, collecting the messages (stdout) and invocation logs:

```shell script
npx -q @cumulusds/dlq --region us-east-2 --function-name MyService-prod-aggregator --redrive --log var/MyService-prod-aggregator/us-east-2/2020-07-15-E- > var/StsHistorian-prod-workCompletionMessageReceived/us-east-2/2020-07-15-E.json
```

The first line of the log file shows the message ID. The second line shows either "Success" or the Function Error. The third line gives the response payload (if any). The remainder of the log file gives the final 4KB of CloudWatch logs emitted by the handler. Here is an example log file `var/MyService-prod-aggregator/us-east-2/2020-07-15-E-1e1474a1-5e1d-4faf-bc85-c3a1cf04defa.log`:

```text
1e1474a1-5e1d-4faf-bc85-c3a1cf04defa
Unhandled
{"errorType":"ConditionalCheckFailedException","errorMessage":"The conditional request failed","trace":[...]}
CONFLICT
REPORT RequestId: cc403fbe-86ec-4768-9036-b3859648d479	Duration: 1020.00 ms	Billed Duration: 1100 ms	Memory Size: 128 MB	Max Memory Used: 115 MB
XRAY TraceId: 1-5f0f6b9f-88681def73d028a27d8e29bb	Segment
```

### Drain messages

```
npx -q @cumulusds/dlq --region us-east-1 --function-name MyService-dev-aggregator --drain
```

The command echos each JSON message on a separate line and deletes it from the queue.

### Queue Dead Letter Target

A primary SQS queue can be configured with another SQS queue as a dead letter target. The command redrives dead letters back to the primary queue:

```shell script
npx -q @cumulusds/dlq --region us-east-1 --queue-url https://sqs.us-east-1.amazonaws.com/000000000000/PrimaryQueueName --redrive
```

The `--log` option creates a log file with the MessageId for each redriven message:

```shell script
npx -q @cumulusds/dlq --region us-east-1 --queue-url https://sqs.us-east-1.amazonaws.com/000000000000/PrimaryQueueName --redrive --log filename-prefix-
```

### Driving Rate

Use the --rate option to set the initial number of messages per second. The utility uses [additive-increase/multiplicative-decrease] to adapt the message rate, based on success or failure of the target. The default rate is 10/second.

[additive-increase/multiplicative-decrease]: https://en.wikipedia.org/wiki/Additive_increase/multiplicative_decrease

### Editing Messages

In some cases, you may need to filter or alter messages before re-driving. Accomplish this with a three-step process:

1. Drain the dead messages to a log file. Note that the messages are removed from the DLQ. Your log file becomes the only record of these messages, so be careful not to overwrite it.
   ```shell
   npx -q @cumulusds/dlq --region us-east-1 --function-name MyService-dev-aggregator --drain > var/raw-events.log
   ```
2. Modify the message-set using sed, jq, etc.
   ```shell
   sed 's/bad-mode/good-mode/g' < raw-events.log > var/processed-events.log
   ```
3. Use the `--from-file` option to redrive events from the edited log file.
   ```shell
   npx -q @cumulusds/dlq --region us-east-1 --function-name MyService-dev-aggregator --redrive --from-file processed-events.log > var/redrive-events.log
   ```

### Filtering Messages

Sometimes a large batch of dead letters is due to overload within an aspect of your system. You might end up with a mix of good messages and unwanted or low priority messages in the DLQ.

To avoid repeating the overload problem, consider raising capacity. If the message-stream is not critical, consider adding a backpressure mechanism to move the overload upstream. Or maybe add a fairness mechanism

## Installation

Packages that define a Dead Letter Queue can create a CLI with customized defaults by adding a file to the scripts directory that uses this library.

To create a CLI tool, add a file to the scripts directory like this, for example "scripts/dlq.js":

```js
import dlq from "dlq";

dlq({ fun: "MyService-dev-aggregator" });
```

Add the new file the scripts section of package.json:

```
"scripts": {
  "dlq": "babel-node scripts/dlq.js"
}
```

# Development

- [Package Structure](doc/development.md#package-structure)
- [Development Environment](doc/development.md#development-environment)
- [Quality](doc/development.md#quality)
- [Release](doc/development.md#release)

## License

This package is [MIT licensed](LICENSE).
