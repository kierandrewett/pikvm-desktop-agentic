/**
 * "1 event", not "1 events".
 *
 * Counts in this panel are read at a glance to judge whether something is
 * working, and a run that has just started really does have one event, a scroll
 * really is one step, a tool group really can hold one input. Every one of those
 * printed its noun in the plural: the Diagnostics sheet said "1 events" beside
 * "cursor 1", and a scroll action read "Scroll down 1 steps".
 *
 * English -s covers every noun this app counts (event, step, input, row,
 * column). Anything irregular can pass its own plural rather than teach this
 * function about English.
 */
export const countOf = (count: number, singular: string, plural?: string) =>
  `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
