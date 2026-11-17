<h1 align='center'>ETL-First-Due</h1>

<p align='center'>Bring active First Due CAD dispatches & AVL device locations into the TAK System</p>

## Setup

1. Request a First Due REST API service account from the agency's First Due administrator. The account is an
   **Email** and **Password** pair used against `POST /auth/token` - human user credentials should not be shared with
   the integration.
2. Confirm with First Due that the account is permitted to read dispatches (`GET /get-units-by-dispatches`) and, if
   `EnrichDispatches` will be enabled, `GET /dispatches`. AVL layers require `GET /device-locations`.
3. Provide the credentials to the ETL First Due Integration.

## Configuration

| Field | Required | Description |
| ----- | -------- | ----------- |
| `Email` | Yes | Email of the First Due API service account |
| `Password` | Yes | Password of the First Due API service account |
| `BaseURL` | No | Base URL of the First Due REST API - defaults to `https://sizeup.firstduesizeup.com/fd-api/v1/` |
| `DataType` | No | `CAD` writes active dispatches to CloudTAK Events with their dispatched units as Assignments, `AVL` posts device locations to the map - defaults to `CAD` |
| `IncludeNotes` | No | CAD Only: Include the CAD dispatch `message` and `call_notes` in the Event remarks - defaults to `true` |
| `EnrichDispatches` | No | CAD Only: Also query `GET /dispatches` to add cross streets, radio channel and alarm level. Roughly doubles the number of API requests per poll - defaults to `false` |
| `BoundingBox` | No | CAD Only: `minLon,minLat,maxLon,maxLat` of acceptable geocoded locations - ie `-105.4,39.5,-104.6,40.0`. Geocoded results outside of the box are discarded |
| `FallbackCoordinates` | No | CAD Only: `Latitude,Longitude` used to place calls that have no verified coordinates and could not be geocoded - ie `38.8419,-105.0522`. Unlocated calls are skipped when unset |
| `ExpireHours` | No | CAD Only: Hours after the last poll at which a dispatch Event ends on its own if the layer stops reporting - defaults to `1` |
| `StaleMinutes` | No | AVL Only: Minutes after the last successful poll before a device is shown as stale on TAK clients - defaults to `10` |
| `DEBUG` | No | Print raw API responses in the layer logs |

A layer handles either CAD or AVL data. To bring both into TAK, create two layers that share the same credentials - one
with `DataType: CAD` and one with `DataType: AVL`.

The task exposes two named Output schemas - `dispatch` (active calls, attached to each Event as metadata) and `device`
(AVL device locations) - an `AVL` layer selects `device` in the CloudTAK Layer Schema & Styles panels.

## How it Works

| Step | Endpoint | Notes |
| ---- | -------- | ----- |
| Authenticate | `POST /auth/token` | JSON body with `grant_type: client_credentials`, `email` & `password`. Returns a Bearer token valid for 14 days |
| Active Calls | `GET /get-units-by-dispatches?active_only=true` | Paginated 20 per page via the `Link` header `rel="next"` relation |
| Enrich (optional) | `GET /dispatches?since=<oldest active created_at>` | Adds `cross_streets`, `radio_channel`, `alarm_level`, `fire_zone` & `fire_stations` |
| Device Locations | `GET /device-locations` | Only requested when `DataType` is `AVL` - replaces the Active Calls & Enrich steps |

The Bearer token is cached in the layer's ephemeral store and reused until an hour before it expires. If First Due rejects
the cached token the ETL re-authenticates once and retries the request.

Every poll retrieves the complete set of active calls or device locations. If any page fails the poll is aborted and nothing
is written so a partial snapshot never causes calls to be ended. Pagination follows the `Link` header, re-applies
`active_only=true` on every page (the documented examples omit it) and refuses to follow links to a different origin.

### Events

- Each active dispatch is written to one CloudTAK Event filed under the external ID `{ system: 'first-due', value: <id> }`,
  so changes to notes, address or units update the existing Event rather than creating a duplicate.
- The Event name is `<type> (<xref_id>)` - the CAD/external reference is used when present, otherwise the First Due ID.
  The address is the Event location and `created_at` is its start time. First Due exposes no call priority, so Events are
  unprioritised.
- Remarks carry the call reference, type, status, place name, cross streets, radio channel, stations and - when
  `IncludeNotes` is enabled - the dispatch message and call notes.
- Every code in `unit_codes` becomes an Assignment on the Event marked with the remark `First Due CAD Unit`. Units that
  leave the call are removed; people assigned by users are left alone. The nested `units` array - responder names,
  emails and status history - is never read, so an Assignment carries no status and nothing is written to the Timeline.
- The full dispatch record (minus coordinates and the nested `units` array) is attached as the Event metadata.
- The ID and a digest of the last state written for each call are cached in the layer's ephemeral store. An unchanged
  call costs no CloudTAK API calls. If the cache is lost the Event is found again by its external ID.
- Closed or cancelled calls drop out of the active feed and their Events are ended. Every write also sets the Event to end
  `ExpireHours` later and an unchanged call has its expiry pushed out once half of that window has elapsed, so if the
  layer stops polling its Events end on their own.

### Locations

- Calls with missing, non-numeric, out of range or `0,0` coordinates are unlocated.
- When the layer has the `search:read` permission the call's address is geocoded through the CloudTAK Search API.
  Results outside of `BoundingBox` are discarded. A geocoded call carries a `Location: Geocoded` remark.
- Otherwise, when `FallbackCoordinates` is set the call is placed there with an `UNLOCATED - ` name prefix and a
  `Location: UNVERIFIED` remark. When unset the call is skipped.
- `located` is `false` in the metadata of every call that was not placed by CAD supplied coordinates.

### AVL Marker Behaviour

- Each device is posted with the stable ID `first-due-device-<id>` and the device `name` as its callsign.
- Remarks carry the device type, responder status, the address being responded to, the assigned station and the time
  of the last location update. The full record (minus coordinates) is available in the feature metadata.
- Devices with a `status_code` other than `active` and devices with missing, non-numeric, out of range or `0,0`
  coordinates are skipped - `FallbackCoordinates` is never applied to a device.
- The marker time is the device's `updated_at` while the stale time is `StaleMinutes` after the poll, so a device that
  has stopped reporting remains on the map at its last known location for as long as First Due returns it.

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
- An unlocated call is geocoded again on every poll for as long as it stays unlocated.
- First Due documents a single example of `GET /device-locations` with no parameters or pagination. `Link` header
  pagination is followed if it is returned. Devices can be apparatus or the mobile devices of individual responders -
  confirm with the agency which devices report before sharing the layer.

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

`task.ts` holds only the control flow. API calls to First Due - authentication, pagination & record validation - live in
the `lib/firstdue.ts` client, `lib/cad.ts` maps dispatches to Events & devices to CoT features and defines the Output
schemas, `lib/events.ts` keeps CloudTAK Events & Assignments in step with the active calls and `lib/geocode.ts` wraps the
CloudTAK Search API.

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
