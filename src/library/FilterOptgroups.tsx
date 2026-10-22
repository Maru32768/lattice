import type { FilterGroup } from "./scopes";

/** Genre / feed / tag `<optgroup>`s inside a scope `<select>`; option values are `filterKey`s. */
export function FilterOptgroups({ groups }: { groups: FilterGroup[] }) {
  return groups.map((g) => (
    <optgroup key={g.label} label={g.label}>
      {g.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
    </optgroup>
  ));
}
