import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LibraryName } from "@/lib/api";

/** The value of "All libraries", which no library id can be. */
const ALL = "all";

/**
 * The library switch (#84, "Console"): the official `Select`, one item per
 * active library, named "Library" for assistive technology (its value is
 * the visible label). The Overview adds "All libraries" first (`allLabel`),
 * for `value` `null`; the Files page has no such item. A page shows it only
 * where more than one library exists, so a single-library console looks as
 * it did.
 *
 * A value no library has (one removed meanwhile) shows as "Library" until
 * another is chosen.
 */
export function LibrarySelect({
  libraries,
  value,
  onValueChange,
  allLabel,
}: {
  libraries: readonly LibraryName[];
  value: number | null;
  onValueChange: (library: number | null) => void;
  allLabel?: string;
}) {
  const items = [
    ...(allLabel === undefined ? [] : [{ value: ALL, label: allLabel }]),
    ...libraries.map((library) => ({ value: String(library.id), label: library.name })),
  ];
  const selected = value === null ? ALL : String(value);

  return (
    <Select
      items={items}
      value={items.some((item) => item.value === selected) ? selected : null}
      onValueChange={(next) => {
        if (typeof next === "string") {
          onValueChange(next === ALL ? null : Number(next));
        }
      }}
    >
      {/* As wide as a long name needs on a desktop, the whole column on a
          phone; a longer name is cut short (the trigger's own line clamp). */}
      <SelectTrigger aria-label="Library" className="w-full min-w-0 sm:w-64">
        <SelectValue placeholder="Library" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
