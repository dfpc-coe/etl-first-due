/** Trimmed string from a string or number value - empty & non-text values are null */
export function text(value: unknown): string | null {
    if (typeof value === 'number') return String(value);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

export function toCoordinate(value: unknown): number | null {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

/**
 * Verified WGS84 point from the record or null - 0,0 and out of range values
 * are treated as unlocated rather than plotted
 */
export function coordinates(record: { latitude?: unknown; longitude?: unknown }): [number, number] | null {
    const lat = toCoordinate(record.latitude);
    const lon = toCoordinate(record.longitude);

    if (lat === null || lon === null) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    if (lat === 0 && lon === 0) return null;

    return [lon, lat];
}

export function fallback(value?: string): [number, number] | null {
    if (!value) return null;

    const [lat, lon] = value.split(',').map((part) => toCoordinate(part.trim()));

    if (lat === null || lat === undefined || lon === null || lon === undefined) {
        console.error(`not ok - invalid FallbackCoordinates: ${value}`);
        return null;
    }

    return [lon, lat];
}

export function timestamp(value: unknown, fallback: Date): Date {
    if (typeof value !== 'string' || !value.trim()) return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}
