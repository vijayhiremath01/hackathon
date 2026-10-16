export type AcceptanceStatus = 'accepted' | 'rejected' | 'needs_review';
export type BinRule = { category: string; volume_liters: number };

export function decideBinAcceptance(input: {
  label: string;
  confidence: number | null;
  interpretationGroup: 'confirmed' | 'possible' | 'excluded' | 'missing';
  policy: { min_confidence?: unknown; label_rules?: unknown };
  remainingLiters: number;
}): { status: AcceptanceStatus; category: string | null; volumeLiters: number | null; reason: string } {
  const label = input.label.trim().toLowerCase().replace(/\s+/g, ' ');
  if (input.interpretationGroup === 'excluded' || ['person', 'tie', 'snowboard', 'cell phone', 'chair', 'laptop'].includes(label)) {
    return { status: 'rejected', category: null, volumeLiters: null, reason: 'The saved AI interpretation excludes this detection as unrelated to the configured demo recycling policy.' };
  }
  const rules = input.policy.label_rules;
  const rule = rules && typeof rules === 'object' ? (rules as Record<string, unknown>)[label] as BinRule | undefined : undefined;
  if (!rule || typeof rule.category !== 'string' || typeof rule.volume_liters !== 'number' || !Number.isFinite(rule.volume_liters) || rule.volume_liters <= 0) {
    return { status: 'rejected', category: null, volumeLiters: null, reason: 'This item is not accepted by this bin’s configured demo policy.' };
  }
  if (input.interpretationGroup === 'missing') {
    return { status: 'needs_review', category: rule.category, volumeLiters: null, reason: 'The saved AI interpretation has no validated candidate for this detection.' };
  }
  const minimum = typeof input.policy.min_confidence === 'number' ? input.policy.min_confidence : 0.75;
  if (input.confidence === null || input.confidence < minimum) {
    return { status: 'needs_review', category: rule.category, volumeLiters: null, reason: `Detection confidence is below the configured ${Math.round(minimum * 100)}% demo threshold.` };
  }
  if (input.remainingLiters + 1e-9 < rule.volume_liters) {
    return { status: 'rejected', category: rule.category, volumeLiters: null, reason: 'There is not enough remaining capacity for this estimated item volume.' };
  }
  if (!['confirmed', 'possible'].includes(input.interpretationGroup)) {
    return { status: 'needs_review', category: rule.category, volumeLiters: null, reason: 'The saved AI interpretation needs review before this item can be accepted.' };
  }
  return { status: 'accepted', category: rule.category, volumeLiters: rule.volume_liters, reason: `Automatically accepted under the selected bin’s demo policy: AI classification matched and detector confidence met the configured ${Math.round(minimum * 100)}% threshold. Volume is an estimate.` };
}
