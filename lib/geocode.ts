import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { within } from './cad.js';
import type { BBox, Coordinate } from './cad.js';

const SuggestResponse = Type.Object({
    items: Type.Array(Type.Object({
        text: Type.String(),
        magicKey: Type.String()
    }))
});

const ForwardResponse = Type.Object({
    items: Type.Array(Type.Object({
        address: Type.String(),
        location: Type.Object({
            x: Type.Number(),
            y: Type.Number()
        }),
        score: Type.Number()
    }))
});

export type GeocoderOptions = {
    /** CloudTAK API the task is running against */
    api: string | URL;
    /** Authenticated GET returning the parsed JSON body - ie ETL.fetch */
    fetch: (url: URL) => Promise<unknown>;
    /** Results outside of the box are rejected and its centre biases the search */
    bbox: BBox | null;
    debug?: boolean;
};

/**
 * Geocode free form addresses via the CloudTAK Search API - suggest returns a
 * magicKey which forward resolves to a location. Requires the search:read
 * permission. Every address is resolved at most once per instance
 */
export default class Geocoder {
    opts: GeocoderOptions;
    cache = new Map<string, Coordinate | null>();

    constructor(opts: GeocoderOptions) {
        this.opts = opts;
    }

    /**
     * @returns [lon, lat] or null if no acceptable location was found
     */
    async locate(address: string): Promise<Coordinate | null> {
        const cached = this.cache.get(address);
        if (cached !== undefined) return cached;

        let geometry: Coordinate | null = null;

        try {
            geometry = await this.resolve(address);
        } catch (err) {
            console.error(`not ok - geocoding "${address}" failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (this.opts.debug) console.error(`DEBUG - geocoded "${address}" => ${geometry ? geometry.join(',') : 'no acceptable result'}`);

        this.cache.set(address, geometry);

        return geometry;
    }

    private async resolve(address: string): Promise<Coordinate | null> {
        const box = this.opts.bbox;

        const suggest = new URL('/api/search/suggest', this.opts.api);
        suggest.searchParams.set('query', address);
        suggest.searchParams.set('limit', '1');

        if (box) {
            suggest.searchParams.set('longitude', String((box[0] + box[2]) / 2));
            suggest.searchParams.set('latitude', String((box[1] + box[3]) / 2));
        }

        const suggestion = Value.Parse(SuggestResponse, await this.opts.fetch(suggest)).items.at(0);
        if (!suggestion) return null;

        const forward = new URL('/api/search/forward', this.opts.api);
        forward.searchParams.set('query', suggestion.text);
        forward.searchParams.set('magicKey', suggestion.magicKey);
        forward.searchParams.set('limit', '1');

        const result = Value.Parse(ForwardResponse, await this.opts.fetch(forward)).items.at(0);
        if (!result) return null;

        const candidate: Coordinate = [result.location.x, result.location.y];

        if (!within(box, candidate)) {
            if (this.opts.debug) console.error(`DEBUG - geocoded "${address}" to ${candidate.join(',')} which is outside of BoundingBox - rejecting`);
            return null;
        }

        return candidate;
    }
}
