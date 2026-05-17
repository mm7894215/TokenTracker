import { copy } from "./copy";
import { isDetailDateKey, sortDetailRows } from "./detail-sort";

type AnyRecord = Record<string, any>;

function buildDailySortColumns() {
  return [
    { key: "day", label: copy("daily.sort.date.label"), title: copy("daily.sort.date.title") },
    { key: "total_tokens", label: copy("daily.sort.total.label"), title: copy("daily.sort.total.title") },
    { key: "input_tokens", label: copy("daily.sort.input.label"), title: copy("daily.sort.input.title") },
    { key: "output_tokens", label: copy("daily.sort.output.label"), title: copy("daily.sort.output.title") },
    {
      key: "cached_input_tokens",
      label: copy("daily.sort.cached.label"),
      title: copy("daily.sort.cached.title"),
    },
    {
      key: "reasoning_output_tokens",
      label: copy("daily.sort.reasoning.label"),
      title: copy("daily.sort.reasoning.title"),
    },
    {
      key: "conversation_count",
      label: copy("daily.sort.conversations.label"),
      title: copy("daily.sort.conversations.title"),
    },
  ];
}

export function getDetailsSortColumns(dateKey: any) {
  const key = isDetailDateKey(dateKey) ? dateKey : "day";
  return buildDailySortColumns().map((col, index) => (index === 0 ? { ...col, key } : col));
}

export function sortDailyRows(rows: any, { key, dir }: AnyRecord) {
  return sortDetailRows(rows, { key, dir });
}
