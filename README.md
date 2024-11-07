# supersetbot

<img width="300" alt="Screenshot 2024-04-02 at 11 03 46 PM" src="https://github.com/apache-superset/supersetbot/assets/487433/c3eb1414-f760-48d3-8a69-c99788247966">


supersetbot is a utility bot that can be used to help around GitHub, CI and beyond.

The bot can be used as a local CLI OR, for a subset of fitted use cases, can be invoked directly
from GitHub comments.

Because it's its own npm app, it can be tested/deployed/used in isolation from the rest of
Superset, and take on some of the complexity from GitHub actions and onto a nifty
utility that can be used in different contexts.

## Features

```
$ use nvm 20
$ npm i -g supersetbot
$ supersetbot
$ ./src/supersetbot
Usage: supersetbot [options] [command]

Options:
  -v, --verbose                      Output extra debugging information
  -r, --repo <repo>                  The GitHub repo to use (ie:"apache/superset")
  -d, --dry-run                      Run the command in dry-run mode
  -a, --actor <actor>                The actor
  -h, --help                         display help for command

Commands:
  label [options] <label>            Add a label to an issue or PR
  unlabel [options] <label>          Remove a label from an issue or PR
  orglabel [options]                 Add an org label based on the author
  release-label-pr [options] <prId>  Figure out first release for PR and label it
  version                            Prints supersetbot's version number
  release-label-prs [options]        Given a set of PRs, auto-release label them
  release-label [options] <release>  Figure out first release for PR and label it
  bump-python [options]              Submit PR(s) to bump python dependencies
  docker [options]                   Generates/run docker build commands use in CI
  run <command>                      Run a command from Github Action
  help [command]                     display help for command
```
