import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type { Feature } from '@tak-ps/node-cot';
import { Dispatch, DeviceLocation } from './firstdue.js';
import { EventSync } from './events.js';
import type { Assignee, SyncedCall } from './events.js';
import { remarks } from './markdown.js';

/** MIL-STD-2525E Incident symbol - the CloudTAK default for a new Event */
export const EVENT_SIDC = '10034000001100000000';

export type Coordinate = [number, number];

export type BBox = [number, number, number, number];

/** Where the position of a call came from */
export type LocationSource = 'cad' | 'geocoded' | 'fallback';

export const DeviceSchema = Type.Omit(DeviceLocation, ['latitude', 'longitude']);

export const DispatchSchema = Type.Composite([
    Type.Omit(Dispatch, ['latitude', 'longitude']),
    Type.Object({
        located: Type.Boolean({ description: 'False when the call had no verified coordinates and was geocoded from its address or placed at FallbackCoordinates' })
    })
]);

/** Trimmed string from a string or number value - empty & non-text values are null */
export function text(value: unknown): string | null {
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

function toCoordinate(value: unknown): number | null {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

/**
 * Verified WGS84 point from the record or null - 0,0 and out of range values
 * are treated as unlocated rather than plotted
 */
export function coordinates(record: { latitude?: unknown; longitude?: unknown }): Coordinate | null {
    const lat = toCoordinate(record.latitude);
    const lon = toCoordinate(record.longitude);

    if (lat === null || lon === null) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    if (lat === 0 && lon === 0) return null;

    return [lon, lat];
}

/**
 * Parse a Latitude,Longitude input - calls without a usable location are
 * placed here so they are still visible on the map
 */
export function parseFallback(value: string | undefined): Coordinate | null {
    if (!value) return null;

    const [lat, lon] = value.split(',').map((part) => toCoordinate(part.trim()));

    if (lat === null || lat === undefined || lon === null || lon === undefined) {
        console.error(`not ok - invalid FallbackCoordinates: ${value}`);
        return null;
    }

    return [lon, lat];
}

/**
 * Parse a minLon,minLat,maxLon,maxLat input - null when unset so geocoded
 * results are accepted anywhere
 */
export function parseBBox(value: string | undefined): BBox | null {
    if (!value) return null;

    const parts = value.split(',').map((part) => Number(part.trim()));
    const [minLon, minLat, maxLon, maxLat] = parts;

    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)) || minLon > maxLon || minLat > maxLat) {
        console.error(`not ok - invalid BoundingBox: ${value}`);
        return null;
    }

    return [minLon, minLat, maxLon, maxLat];
}

export function within(box: BBox | null, [lon, lat]: Coordinate): boolean {
    if (!box) return true;
    return lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3];
}

export function parseTimestamp(value: unknown): Date | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function dispatchId(dispatch: Pick<Static<typeof Dispatch>, 'id'>): string | null {
    return text(dispatch.id);
}

/** Closed & cancelled calls can linger in the active feed */
export function isOpen(dispatch: Pick<Static<typeof Dispatch>, 'status_code'>): boolean {
    const status = text(dispatch.status_code);
    return !status || status === 'open';
}

/** Calls that are never closed in CAD stay in the active feed indefinitely */
export function isRecent(dispatch: Pick<Static<typeof Dispatch>, 'created_at'>, since: Date | undefined): boolean {
    if (!since) return true;
    const created = parseTimestamp(dispatch.created_at);
    return !created || created >= since;
}

export function addressLine(dispatch: Static<typeof Dispatch>): string | null {
    const street = [text(dispatch.address), text(dispatch.address2)].filter((part) => part !== null).join(' ');
    const parts = [street || null, text(dispatch.city), text(dispatch.state_code)].filter((part) => part !== null);
    return parts.length > 0 ? parts.join(', ') : text(dispatch.location);
}

function unitCodes(dispatch: Pick<Static<typeof Dispatch>, 'unit_codes'>): Array<string> {
    return (dispatch.unit_codes ?? []).map((unit) => unit.trim()).filter(Boolean);
}

/**
 * Units dispatched to a call become Assignments on the Event - one per unit
 * code. The nested `units` array is not read, so a unit carries no status
 */
export function assignees(dispatch: Pick<Static<typeof Dispatch>, 'unit_codes'>): Array<Assignee> {
    const byName = new Map<string, Assignee>();

    for (const unit of unitCodes(dispatch)) {
        const name = EventSync.clampName(unit);
        byName.set(name, { name, role: '' });
    }

    return [...byName.values()];
}

export type CallOptions = {
    /** Include the CAD dispatch message & call notes in the Event remarks - default true */
    includeNotes?: boolean;
    /** Where the geometry came from - default cad */
    source?: LocationSource;
};

/**
 * Map an active dispatch to the Event written to CloudTAK
 */
export function callOf(id: string, dispatch: Static<typeof Dispatch>, geometry: Coordinate, opts: CallOptions = {}): SyncedCall {
    const includeNotes = opts.includeNotes ?? true;
    const source = opts.source ?? 'cad';

    const started = parseTimestamp(dispatch.created_at)?.toISOString();
    const reference = text(dispatch.xref_id) ?? id;
    const type = text(dispatch.type) ?? text(dispatch.incident_type_code) ?? 'Dispatch';

    const metadata: Static<typeof DispatchSchema> = {
        id: dispatch.id,
        xref_id: text(dispatch.xref_id),
        type: text(dispatch.type),
        status_code: text(dispatch.status_code),
        incident_type_code: text(dispatch.incident_type_code),
        unit_codes: unitCodes(dispatch),
        created_at: started ?? null,
        place_name: text(dispatch.place_name),
        address: text(dispatch.address),
        address2: text(dispatch.address2),
        city: text(dispatch.city),
        state_code: text(dispatch.state_code),
        location: text(dispatch.location),
        message: includeNotes ? text(dispatch.message) : null,
        call_notes: includeNotes ? text(dispatch.call_notes) : null,
        cross_streets: text(dispatch.cross_streets),
        radio_channel: text(dispatch.radio_channel),
        alarm_level: text(dispatch.alarm_level),
        fire_zone: text(dispatch.fire_zone),
        fire_stations: dispatch.fire_stations ?? null,
        located: source === 'cad'
    };

    return {
        external: id,
        event: {
            name: EventSync.clampName(`${source === 'fallback' ? 'UNLOCATED - ' : ''}${type} (${reference})`),
            type: EVENT_SIDC,
            priority: 'none',
            geometry: {
                type: 'Point',
                coordinates: geometry
            },
            location: addressLine(dispatch) ?? '',
            started,
            remarks: remarks([
                `Call: ${reference}`,
                text(dispatch.xref_id) ? `First Due ID: ${id}` : null,
                `Type: ${type}`,
                metadata.incident_type_code && metadata.incident_type_code !== type ? `Incident Code: ${metadata.incident_type_code}` : null,
                metadata.status_code ? `Status: ${metadata.status_code}` : null,
                metadata.alarm_level ? `Alarm Level: ${metadata.alarm_level}` : null,
                source === 'geocoded' ? 'Location: Geocoded from the address - no coordinates provided by CAD' : null,
                source === 'fallback' ? 'Location: UNVERIFIED - no coordinates provided by CAD' : null,
                metadata.place_name ? `Place: ${metadata.place_name}` : null,
                metadata.cross_streets ? `Cross Streets: ${metadata.cross_streets}` : null,
                metadata.radio_channel ? `Radio: ${metadata.radio_channel}` : null,
                metadata.fire_zone ? `Fire Zone: ${metadata.fire_zone}` : null,
                metadata.fire_stations && metadata.fire_stations.length > 0 ? `Stations: ${metadata.fire_stations.join(', ')}` : null,
                metadata.message ? `\nMessage:\n${metadata.message}` : null,
                metadata.call_notes ? `\nCall Notes:\n${metadata.call_notes}` : null
            ]),
            metadata
        },
        assignees: assignees(dispatch)
    };
}

export type DeviceOptions = {
    staleMinutes: number;
    now?: Date;
};

/**
 * Map a single AVL device to a CoT Feature - returns null for inactive
 * devices and for devices without a verified location
 */
export function deviceFeature(
    device: Static<typeof DeviceLocation>,
    opts: DeviceOptions
): Static<typeof Feature.InputFeature> | null {
    const id = text(device.id);
    if (!id) return null;

    if (text(device.status_code) && text(device.status_code) !== 'active') {
        return null;
    }

    const geometry = coordinates(device);
    if (!geometry) return null;

    const now = opts.now ?? new Date();
    const updated = parseTimestamp(device.updated_at) ?? now;

    const callsign = text(device.name) ?? `Device ${id}`;

    const metadata: Static<typeof DeviceSchema> = {
        id: device.id,
        name: text(device.name),
        type: text(device.type),
        status_code: text(device.status_code),
        updated_at: updated.toISOString(),
        responder_status: text(device.responder_status),
        responder_status_code: text(device.responder_status_code),
        responding_address: text(device.responding_address),
        responding_dispatch_place_location: text(device.responding_dispatch_place_location),
        fire_station_id: device.fire_station_id ?? null,
        fire_station_name_or_number: text(device.fire_station_name_or_number)
    };

    const responding = metadata.responding_dispatch_place_location ?? metadata.responding_address;

    return {
        id: `first-due-device-${id}`,
        type: 'Feature',
        properties: {
            callsign,
            type: 'a-f-G-E-V',
            how: 'm-g',
            time: updated.toISOString(),
            start: updated.toISOString(),
            stale: new Date(now.getTime() + opts.staleMinutes * 60 * 1000).toISOString(),
            remarks: remarks([
                `Unit: ${callsign}`,
                metadata.type ? `Type: ${metadata.type}` : null,
                metadata.responder_status ?? metadata.responder_status_code ? `Status: ${metadata.responder_status ?? metadata.responder_status_code}` : null,
                responding ? `Responding To: ${responding}` : null,
                metadata.fire_station_name_or_number ? `Station: ${metadata.fire_station_name_or_number}` : null,
                `Updated: ${updated.toISOString()}`
            ]),
            metadata
        },
        geometry: {
            type: 'Point',
            coordinates: geometry
        }
    };
}
