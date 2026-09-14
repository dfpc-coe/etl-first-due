<h1 align='center'>ETL-First-Due</h1>

<p align='center'>Bring active First Due CAD dispatches into the TAK System</p>

## Setup

1. Request a First Due REST API service account from the agency's First Due administrator. The account is an
   **Email** and **Password** pair used against `POST /auth/token` - human user credentials should not be shared with
   the integration.
2. Confirm with First Due that the account is permitted to read dispatches (`GET /get-units-by-dispatches`) and, if
   `EnrichDispatches` will be enabled, `GET /dispatches`.
3. Provide the credentials to the ETL First Due Integration.

## Configuration

| Field | Required | Description |
| ----- | -------- | ----------- |
| `Email` | Yes | Email of the First Due API service account |
| `Password` | Yes | Password of the First Due API service account |
| `BaseURL` | No | Base URL of the First Due REST API - defaults to `https://sizeup.firstduesizeup.com/fd-api/v1/` |
| `IncludeNotes` | No | Include the CAD dispatch `message` and `call_notes` in the marker remarks - defaults to `true` |
| `EnrichDispatches` | No | Also query `GET /dispatches` to add cross streets, radio channel and alarm level. Roughly doubles the number of API requests per poll - defaults to `false` |
| `FallbackCoordinates` | No | `Latitude,Longitude` used to place calls that have no verified coordinates - ie `38.8419,-105.0522`. Unlocated calls are skipped when unset |
| `StaleMinutes` | No | Minutes after the last successful poll before a marker is shown as stale on TAK clients - defaults to `10` |
| `DEBUG` | No | Print raw API responses in the layer logs |

## How it Works

| Step | Endpoint | Notes |
| ---- | -------- | ----- |
| Authenticate | `POST /auth/token` | JSON body with `grant_type: client_credentials`, `email` & `password`. Returns a Bearer token valid for 14 days |
| Active Calls | `GET /get-units-by-dispatches?active_only=true` | Paginated 20 per page via the `Link` header `rel="next"` relation |
| Enrich (optional) | `GET /dispatches?since=<oldest active created_at>` | Adds `cross_streets`, `radio_channel`, `alarm_level`, `fire_zone` & `fire_stations` |

The Bearer token is cached in the layer's ephemeral store and reused until an hour before it expires. If First Due rejects
the cached token the ETL re-authenticates once and retries the request.

Every poll retrieves the complete set of active calls. If any page fails the poll is aborted and nothing is submitted so a
partial snapshot never causes calls to disappear. Pagination follows the `Link` header, re-applies `active_only=true` on
every page (the documented examples omit it) and refuses to follow links to a different origin.

### Marker Behaviour

- Each call is posted with the stable ID `first-due-<id>` so changes to notes, address, or units update the existing
  marker rather than creating a duplicate. A reopened call reuses the same ID and reappears.
- The marker callsign is `<type> (<xref_id>)` - the CAD/external reference is used when present, otherwise the First Due
  ID.
- Remarks carry the call reference, type, status, creation time, place name, address, cross streets, radio channel,
  assigned units and - when `IncludeNotes` is enabled - the dispatch message and call notes.
- The full dispatch record (minus coordinates and the nested `units` array, which contains responder names and emails) is
  available in the feature metadata.
- Closed or cancelled calls drop out of the active feed and are no longer posted. TAK clients remove them once the
  `StaleMinutes` window elapses.
- If a poll fails, no update is sent and the existing markers are shown as stale by TAK clients once `StaleMinutes`
  elapses - a call is never shown as current without a successful poll behind it.
- Calls with missing, non-numeric, out of range or `0,0` coordinates are unlocated. When `FallbackCoordinates` is set
  they are placed there with an `UNLOCATED - ` callsign prefix, a `Location: UNVERIFIED` remark and `located: false` in
  the metadata. When unset they are skipped.

### Limitations

- The `since` parameter on both dispatch endpoints filters on creation time only, so the ETL always retrieves the full
  active set rather than polling for changes.
- First Due does not document rate limits for the REST API. The default schedule polls every 15 seconds, which at the
  documented page size is roughly `4 * ceil(active_calls / 20)` requests per minute (double with `EnrichDispatches`).
  Confirm the agency's limits with First Due before a pilot and lengthen the schedule if they are exceeded.
- Sub-minute schedules are run by the CloudTAK events pool rather than AWS EventBridge, so the ETL must have been
  built with the `schedule` invocation enabled and the layer must be enabled for polling to occur.
- Whether `call_notes` reflects the complete current CAD narrative, including later corrections, depends on the agency's
  CAD to First Due integration and should be verified during a pilot.
- Retrieval is capped at 50 pages (1000 active calls) per poll.

## Development

DFPC provided Lambda ETLs are currently all written in [NodeJS](https://nodejs.org/en) through the use of a AWS Lambda optimized
Docker container. Documentation for the Dockerfile can be found in the [AWS Help Center](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

```sh
npm install
```

Add a .env file in the root directory that gives the ETL script the necessary variables to communicate with a local ETL server.
When the ETL is deployed the `ETL_API` and `ETL_LAYER` variables will be provided by the Lambda Environment

```json
{
    "ETL_API": "http://localhost:5001",
    "ETL_LAYER": "19"
}
```

To run the task, ensure the local [CloudTAK](https://github.com/dfpc-coe/CloudTAK/) server is running and then run with typescript runtime
or build to JS and run natively with node

```
ts-node task.ts
```

```
npm run build
cp .env dist/
node dist/task.js
```

Run the unit tests with

```sh
npm test
```

### Deployment

Deployment into the CloudTAK environment for configuration is done via automatic releases to the DFPC AWS environment.

Github actions will build and push docker releases on every version tag which can then be automatically configured via the
CloudTAK API.

Builds are performed by the `cloudtak-etl` script provided by [`@tak-ps/etl`](https://github.com/dfpc-coe/etl-base).
It requires a `capabilities.json` document alongside the `Dockerfile` which describes the task (name, description,
compute requirements, permissions & invocation types) and is validated and embedded in the OCI Image Manifest as a
`com.cloudtak.capabilities` annotation so CloudTAK can read it directly from ECR before the task is ever deployed.
Update `capabilities.json` whenever the task's requirements change.

To build & push manually:

```sh
export AWS_REGION='us-east-1'
export AWS_ACCOUNT_ID='123456789012'
export Environment='prod' # Optional - defaults to prod

npx cloudtak-etl
```

Non-DFPC users will need to setup their own docker => ECS build system via something like Github Actions or AWS Codebuild.
