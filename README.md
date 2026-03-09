# memory engine integrations

A collection of integrations that connect external data sources to [memory engine](https://memoryengine.build).

## Integrations

| Integration | Description |
|-------------|-------------|
| [git-history](./git-history/) | Backfill and incrementally sync git commits into searchable memories |

## Usage

Each integration is a standalone script with its own README and dependencies. See the individual directories for setup and usage instructions.

All integrations use the `@memoryengine/client` SDK and authenticate via `ME_SERVER` and `ME_API_KEY` environment variables.
