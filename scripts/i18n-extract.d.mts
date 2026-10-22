/** A Japanese UI string found outside the catalogs. */
export interface Found {
  file: string;
  line: number;
  ja: string;
}
export function jsxText(raw: string): string;
export function scan(file: string): Found[];
export function sourceFiles(dir?: string): string[];
