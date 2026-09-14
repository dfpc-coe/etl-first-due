# CHANGELOG

## Emoji Cheatsheet
- :pencil2: doc updates
- :bug: when fixing a bug
- :rocket: when making general improvements
- :white_check_mark: when adding tests
- :arrow_up: when upgrading dependencies
- :tada: when adding new features

## Version History

### Pending Release

### v1.0.0

- :tada: Initial Approach - poll `GET /get-units-by-dispatches?active_only=true` every 15 seconds and post active calls to the map
- :tada: Cache the Bearer token in the layer ephemeral store and re-authenticate once when it is rejected
- :tada: Follow `Link` header pagination, keeping `active_only=true` on every page
- :tada: Optional `EnrichDispatches` merges cross streets, radio channel & alarm level from `GET /dispatches`
- :tada: Optional `FallbackCoordinates` places calls without verified coordinates and flags them as `UNLOCATED`
- :white_check_mark: Unit tests for coordinate validation, Link pagination and feature mapping
