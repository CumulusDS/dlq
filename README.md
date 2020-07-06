# DQL

CLI generator for operations on a Dead Letter Queue.

## Usage

### Show messages
```
npx -q dlq --region us-east-1 --stage ci-cd --function-name MyService-dev-aggregator
```

The command echos each JSON message on a separate line without removing from the queue.

### Redrive messages
```
npx -q dlq --region us-east-1 --stage ci-cd --function-name MyService-dev-aggregator --redrive
```

The command invokes the function with each message. Then the command deletes each re-driven message from the queue. The invocation is asynchronous, so if the message fails again, a new DLQ message is created by AWS Lambda.

### Drain messages
```
npx -q dlq --region us-east-1 --stage ci-cd --function-name MyService-dev-aggregator --drain
```

The command echos each JSON message on a separate line and deletes it from the queue.

## Installation

Packages that define a Dead Letter Queue can create a CLI with customized defaults by adding a file to the scripts directory that uses this library. 

To create a CLI tool, add a file to the scripts directory like this, for example "scripts/dlq.js":
```js
import dlq from "dlq";

dlq({fun: "MyService-dev-aggregator"});
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