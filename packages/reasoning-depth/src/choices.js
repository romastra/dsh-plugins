/** Build only adapter-advertised choices, in the adapter's preferred order. */
export function buildEffortView(state) {
  const selection = state?.pending ?? state?.current;
  if (!selection) return null;
  const group = state.groups?.find(item => item.id === selection.provider);
  const model = group?.models?.find(item => item.id === selection.model);
  const reasoning = model?.reasoning;
  if (!reasoning || !Array.isArray(reasoning.efforts) || reasoning.efforts.length === 0) return null;
  // Omitted effort is a request policy, not a reasoning level. Never invent a Default/None stop.
  const choices = reasoning.efforts;
  const effective = selection.reasoningEffort ?? reasoning.defaultEffort;
  const index = choices.findIndex(item => item.id === effective);
  // Do not silently clamp or mislabel a stale, unsupported saved effort.
  if (index < 0 && effective !== undefined) return null;
  return {
    selection,
    model,
    choices,
    index,
    selectionRequired: index < 0,
    key: JSON.stringify([selection.provider, selection.model, choices.map(item => item.id ?? null)]),
  };
}

export function selectionAt(view, index) {
  if (!view || !Number.isInteger(index) || index < 0 || index >= view.choices.length) return null;
  const effort = view.choices[index].id;
  return {
    provider: view.selection.provider,
    model: view.selection.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
}

export function stopPercent(index, count) {
  return count <= 1 ? 0 : index * 100 / (count - 1);
}
