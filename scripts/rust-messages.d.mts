export function rustMessageUsage(source: string): {
  calls: { code: string; params: string[] }[];
  strings: Set<string>;
  dynamicField: boolean;
};
