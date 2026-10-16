export const IRRELEVANT_DETECTION_LABELS = new Set([
  'person', 'tie', 'chair', 'laptop', 'keyboard', 'mouse', 'tv', 'television', 'snowboard',
  'bus', 'car', 'truck', 'motorcycle', 'airplane', 'train', 'boat', 'sports ball', 'kite',
  'skateboard', 'surfboard', 'tennis racket', 'baseball bat', 'baseball glove', 'bench',
  'toilet', 'refrigerator', 'oven', 'microwave', 'toaster', 'remote', 'cell phone', 'clock',
  'vase', 'scissors', 'hair drier', 'toothbrush', 'dog', 'cat', 'bird', 'horse', 'sheep',
  'cow', 'elephant', 'bear', 'zebra', 'giraffe',
]);

// These COCO labels can be considered possible waste, but without the source
// photograph or a user-confirmed disposal event they cannot prove an item is waste.
export const POSSIBLE_WASTE_LABELS = new Set(['bottle', 'cup', 'wine glass', 'book']);

export function normalizedLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : 'unknown';
}
