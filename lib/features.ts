import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type { Feature } from '@tak-ps/node-cot';
import { Dispatch, DeviceLocation } from './firstdue.js';
import { text, timestamp, coordinates } from './parse.js';

export const DeviceSchema = Type.Omit(DeviceLocation, ['latitude', 'longitude']);

export const DispatchSchema = Type.Composite([
    Type.Omit(Dispatch, ['latitude', 'longitude']),
    Type.Object({
        located: Type.Boolean({ description: 'False when the call had no verified coordinates and was placed at FallbackCoordinates' })
    })
]);

function addressLine(dispatch: Static<typeof Dispatch>): string | null {
    const street = [text(dispatch.address), text(dispatch.address2)].filter((part) => part !== null).join(' ');
    const parts = [street || null, text(dispatch.city), text(dispatch.state_code)].filter((part) => part !== null);
    return parts.length ? parts.join(', ') : text(dispatch.location);
}

function remarks(lines: Array<string | null>): string | undefined {
    const body = lines.filter((line) => line !== null).join('\n');
    return body || undefined;
}

export type FeatureOptions = {
    includeNotes: boolean;
    fallback: [number, number] | null;
    staleMinutes: number;
    now?: Date;
};

/**
 * Map a single active dispatch to a CoT Feature - returns null for closed
 * calls and for unlocated calls when no FallbackCoordinates are configured
 */
export function dispatchFeature(
    dispatch: Static<typeof Dispatch>,
    opts: FeatureOptions
): Static<typeof Feature.InputFeature> | null {
    const id = text(dispatch.id);
    if (!id) return null;

    if (text(dispatch.status_code) && text(dispatch.status_code) !== 'open') {
        return null;
    }

    let geometry = coordinates(dispatch);
    const located = geometry !== null;

    if (!geometry) {
        geometry = opts.fallback;
        if (!geometry) {
            console.log(`ok - skipping unlocated dispatch ${id}`);
            return null;
        }
    }

    const now = opts.now ?? new Date();
    const start = timestamp(dispatch.created_at, now);

    const reference = text(dispatch.xref_id) ?? id;
    const type = text(dispatch.type) ?? text(dispatch.incident_type_code) ?? 'Dispatch';
    const units = (dispatch.unit_codes ?? []).map((unit) => unit.trim()).filter((unit) => unit);
    const address = addressLine(dispatch);

    const metadata: Static<typeof DispatchSchema> = {
        id: dispatch.id,
        xref_id: text(dispatch.xref_id),
        type: text(dispatch.type),
        status_code: text(dispatch.status_code),
        incident_type_code: text(dispatch.incident_type_code),
        unit_codes: units,
        created_at: start.toISOString(),
        place_name: text(dispatch.place_name),
        address: text(dispatch.address),
        address2: text(dispatch.address2),
        city: text(dispatch.city),
        state_code: text(dispatch.state_code),
        location: text(dispatch.location),
        message: opts.includeNotes ? text(dispatch.message) : null,
        call_notes: opts.includeNotes ? text(dispatch.call_notes) : null,
        cross_streets: text(dispatch.cross_streets),
        radio_channel: text(dispatch.radio_channel),
        alarm_level: text(dispatch.alarm_level),
        fire_zone: text(dispatch.fire_zone),
        fire_stations: dispatch.fire_stations ?? null,
        located
    };

    return {
        id: `first-due-${id}`,
        type: 'Feature',
        properties: {
            callsign: `${located ? '' : 'UNLOCATED - '}${type} (${reference})`,
            type: 'a-f-G-U-i',
            how: 'h-g-i-g-o',
            time: start.toISOString(),
            start: start.toISOString(),
            stale: new Date(now.getTime() + opts.staleMinutes * 60 * 1000).toISOString(),
            remarks: remarks([
                `Call: ${reference}`,
                text(dispatch.xref_id) ? `First Due ID: ${id}` : null,
                `Type: ${type}`,
                metadata.incident_type_code && metadata.incident_type_code !== type ? `Incident Code: ${metadata.incident_type_code}` : null,
                metadata.status_code ? `Status: ${metadata.status_code}` : null,
                metadata.alarm_level ? `Alarm Level: ${metadata.alarm_level}` : null,
                `Created: ${start.toISOString()}`,
                located ? null : 'Location: UNVERIFIED - no coordinates provided by CAD',
                metadata.place_name ? `Place: ${metadata.place_name}` : null,
                address ? `Address: ${address}` : null,
                metadata.cross_streets ? `Cross Streets: ${metadata.cross_streets}` : null,
                metadata.radio_channel ? `Radio: ${metadata.radio_channel}` : null,
                units.length ? `Units: ${units.join(', ')}` : null,
                metadata.fire_stations && metadata.fire_stations.length ? `Stations: ${metadata.fire_stations.join(', ')}` : null,
                metadata.message ? `\nMessage:\n${metadata.message}` : null,
                metadata.call_notes ? `\nCall Notes:\n${metadata.call_notes}` : null
            ]),
            metadata
        },
        geometry: {
            type: 'Point',
            coordinates: geometry
        }
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
    const updated = timestamp(device.updated_at, now);

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
