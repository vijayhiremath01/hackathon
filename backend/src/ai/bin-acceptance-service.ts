import { sql } from '../db.js';
import { getBinCapacityDetails } from '../queries.js';
import { decideBinAcceptance } from './bin-acceptance.js';

const httpError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const parseJson = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
};

export async function acceptScanDetection(scanId: string, detectionIndex: number) {
  const transactionResult = await sql.begin(async (tx) => {
    const scans = await tx`SELECT id, bin_id, result FROM scans WHERE id = ${scanId} FOR SHARE`;
    const scan = scans[0];
    if (!scan) throw httpError('Scan not found.', 404);
    if (typeof scan.bin_id !== 'string') throw httpError('This scan is not assigned to a bin.', 409);

    const interpretations = await tx`
      SELECT classification_status, prompt_version, interpretation
      FROM ai_scan_interpretations WHERE scan_id = ${scanId} FOR SHARE
    `;
    const saved = interpretations[0];
    const binRows = await tx`
      SELECT capacity_liters, current_fill_liters, near_full_percent, acceptance_policy
      FROM bins WHERE bin_id = ${scan.bin_id} FOR UPDATE
    `;
    const bin = binRows[0];
    if (!bin) throw httpError('Bin not found.', 404);

    const priorRows = await tx`
      SELECT id, scan_id, bin_id, detection_index, detection_label, item_category,
             estimated_volume_liters, acceptance_status, reason, created_at
      FROM bin_item_events WHERE scan_id = ${scanId} AND detection_index = ${detectionIndex}
    `;
    const result = parseJson(scan.result);
    const detections = Array.isArray(result.detections) ? result.detections as Array<Record<string, unknown>> : [];
    const detection = detections[detectionIndex];
    if (!detection) throw httpError('detection_index is not present in this scan.', 400);
    const label = typeof detection.label === 'string' ? detection.label.trim().slice(0, 80) : 'unknown';
    const confidence = typeof detection.confidence === 'number' && Number.isFinite(detection.confidence)
      ? Math.max(0, Math.min(1, detection.confidence)) : null;
    const interpretation = parseJson(saved?.interpretation);
    const findIndex = (key: string) => Array.isArray(interpretation[key])
      ? (interpretation[key] as Array<Record<string, unknown>>).find((item) => item.detection_index === detectionIndex)
      : undefined;
    const confirmed = findIndex('confirmed_waste_items');
    const possible = findIndex('possible_waste_items');
    const excluded = findIndex('excluded_detections');
    const classified = confirmed || possible || excluded;
    const sameLabel = classified && typeof classified.original_label === 'string'
      && classified.original_label.trim().toLowerCase() === label.toLowerCase();
    const capacityLiters = Number(bin.capacity_liters) || 100;
    const fillLiters = Number(bin.current_fill_liters) || 0;
    const policy = parseJson(bin.acceptance_policy);
    const rules = policy.label_rules && typeof policy.label_rules === 'object' ? policy.label_rules as Record<string, unknown> : {};
    const group = sameLabel ? (excluded ? 'excluded' : confirmed ? 'confirmed' : 'possible') : (label in rules ? 'possible' : 'missing');
    const decision = decideBinAcceptance({
      label, confidence, interpretationGroup: group,
      policy, remainingLiters: Math.max(0, capacityLiters - fillLiters),
    });
    if (priorRows[0]) {
      const prior = priorRows[0];
      // A policy or confidence threshold may be tightened or relaxed after a
      // scan. Re-evaluate prior non-accepted events without double-counting
      // events that have already contributed to the fill level.
      if (prior.acceptance_status !== 'accepted' && decision.status === 'accepted' && decision.volumeLiters !== null) {
        const updatedBin = await tx`
          UPDATE bins
          SET current_fill_liters = current_fill_liters + ${decision.volumeLiters}
          WHERE bin_id = ${scan.bin_id}
            AND current_fill_liters + ${decision.volumeLiters} <= capacity_liters
          RETURNING bin_id
        `;
        if (!updatedBin[0]) throw httpError('The bin capacity changed before this item could be recorded. Please refresh and retry.', 409);
        const upgraded = await tx`
          UPDATE bin_item_events
          SET item_category = ${decision.category}, estimated_volume_liters = ${decision.volumeLiters},
              acceptance_status = 'accepted', reason = ${decision.reason}
          WHERE scan_id = ${scanId} AND detection_index = ${detectionIndex}
          RETURNING id, scan_id, bin_id, detection_index, detection_label, item_category,
                    estimated_volume_liters, acceptance_status, reason, created_at
        `;
        return { event: upgraded[0], binId: String(scan.bin_id), duplicate: false };
      }
      return { event: prior, binId: String(scan.bin_id), duplicate: true };
    }
    const id = crypto.randomUUID();
    const inserted = await tx`
      INSERT INTO bin_item_events
        (id, bin_id, scan_id, detection_index, detection_label, item_category,
         estimated_volume_liters, acceptance_status, reason)
      VALUES
        (${id}, ${scan.bin_id}, ${scanId}, ${detectionIndex}, ${label}, ${decision.category},
         ${decision.volumeLiters}, ${decision.status}, ${decision.reason})
      ON CONFLICT (scan_id, detection_index) DO NOTHING
      RETURNING id, scan_id, bin_id, detection_index, detection_label, item_category,
                estimated_volume_liters, acceptance_status, reason, created_at
    `;
    if (!inserted[0]) {
      const duplicate = await tx`
        SELECT id, scan_id, bin_id, detection_index, detection_label, item_category,
               estimated_volume_liters, acceptance_status, reason, created_at
        FROM bin_item_events WHERE scan_id = ${scanId} AND detection_index = ${detectionIndex}
      `;
      return { event: duplicate[0], binId: String(scan.bin_id), duplicate: true };
    }
    if (decision.status === 'accepted' && decision.volumeLiters !== null) {
      const updated = await tx`
        UPDATE bins
        SET current_fill_liters = current_fill_liters + ${decision.volumeLiters}
        WHERE bin_id = ${scan.bin_id}
          AND current_fill_liters + ${decision.volumeLiters} <= capacity_liters
        RETURNING bin_id
      `;
      if (!updated[0]) throw httpError('The bin capacity changed before this item could be recorded. Please refresh and retry.', 409);
    }
    return { event: inserted[0], binId: String(scan.bin_id), duplicate: false };
  });
  const capacity = await getBinCapacityDetails(transactionResult.binId);
  return { event: transactionResult.event, capacity, duplicate: transactionResult.duplicate };
}

export async function autoAcceptScanCandidates(scanId: string, interpretation: Record<string, unknown>) {
  const indices = new Set<number>();
  for (const key of ['confirmed_waste_items', 'possible_waste_items']) {
    const items = interpretation[key];
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item && typeof item === 'object' && Number.isInteger((item as Record<string, unknown>).detection_index)) {
          indices.add((item as Record<string, number>).detection_index);
        }
      }
    }
  }
  const results = [];
  for (const index of indices) results.push(await acceptScanDetection(scanId, index));
  return { results, capacity: results.at(-1)?.capacity ?? null };
}

/** Apply the configured detector-label and confidence policy immediately after upload,
 * without making bin fill dependent on Groq availability or JSON formatting. */
export async function autoAcceptScanDetections(scanId: string) {
  const rows = await sql`
    SELECT s.result, s.bin_id, b.acceptance_policy
    FROM scans s JOIN bins b ON b.bin_id = s.bin_id
    WHERE s.id = ${scanId}
  `;
  const row = rows[0];
  if (!row) return { results: [], capacity: null };
  const result = parseJson(row.result);
  const policy = parseJson(row.acceptance_policy);
  const rules = policy.label_rules && typeof policy.label_rules === 'object' ? policy.label_rules as Record<string, unknown> : {};
  const detections = Array.isArray(result.detections) ? result.detections as Array<Record<string, unknown>> : [];
  const results = [];
  for (const [index, detection] of detections.entries()) {
    const label = typeof detection.label === 'string' ? detection.label.trim().toLowerCase().replace(/\s+/g, ' ') : '';
    if (label in rules) results.push(await acceptScanDetection(scanId, index));
  }
  return { results, capacity: results.at(-1)?.capacity ?? null };
}
