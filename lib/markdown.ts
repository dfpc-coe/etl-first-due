/**
 * Join remark lines, dropping the ones with nothing to say
 */
export function remarks(lines: Array<string | null>): string {
    return lines.filter((line) => line !== null).join('\n');
}
