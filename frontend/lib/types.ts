export type BinId = 'bin-01' | 'bin-02';
export type Detection = { class_id?: number; label: string; confidence?: number; bounding_box?: { x1:number; y1:number; x2:number; y2:number } };
export type ScanResult = { schema_version?: string; status?: string; scan_id?: string; created_at?: string; completed_at?: string; detections?: Detection[]; summary?: { total_detections?: number; counts_by_label?: Record<string, number>; unique_object_classes?: string[] }; bin_id?: BinId };
export type Scan = { id?: string; scan_id?: string; created_at: string; image_filename?: string; result?: ScanResult; total_detections?: number; counts_by_label?: Record<string, number> };
export type Stats = { total_scans: number; total_detections: number; detections_by_label: Record<string, number> };
export type BinCapacity = { bin_id: BinId; capacity_liters: number; current_fill_liters: number; remaining_liters: number; capacity_percentage: number; status: 'AVAILABLE'|'NEAR FULL'|'FULL'; near_full_percent: number; acceptance_policy: { demo?: boolean; note?: string }; recent_item_events: BinItemEvent[] };
export type BinItemEvent = { id: string; scan_id: string; bin_id: BinId; detection_index: number; detection_label: string; item_category: string | null; estimated_volume_liters: number | null; acceptance_status: 'accepted'|'rejected'|'needs_review'; reason: string; created_at: string };
export type BinDetails = { bin_id: BinId; name: string; location: string; total_scans: number; total_detections: number; detections_by_label: Record<string, number>; last_scan_at: string | null; recent_scans: Scan[]; capacity: BinCapacity; acceptance_policy: BinCapacity['acceptance_policy']; recent_item_events: BinItemEvent[] };
export type AiMessage = { id: string; role: 'user' | 'assistant'; content: string; created_at: string };
export type AiSource = { type: 'scan'; scan_id: string; bin_id: BinId | null };
export type InterpretationItem = { detection_index: number; original_label: string; confidence: number | null; material: string | null; reason: string; category: 'relevant_waste' | 'possible_waste' | 'irrelevant_or_unknown' };
export type ScanInterpretation = { scan_id: string; bin_id: BinId | null; classification_status: 'completed' | 'failed' | 'pending'; prompt_version: string; model: string; confirmed_waste_items: InterpretationItem[]; possible_waste_items: InterpretationItem[]; excluded_detections: InterpretationItem[]; summary: string; recommendations: string[]; limitations: string[] };
export type ScanInterpretationRecord = { scan_id:string;bin_id:BinId|null;classification_status:'completed'|'failed'|'pending';prompt_version:string;model:string;interpretation:ScanInterpretation|null;error_message:string|null;created_at:string;updated_at:string };
export const BIN_INFO: Record<BinId, { name:string; location:string; color:string; accent:string }> = {
  'bin-01': { name:'Recycle Bin 01', location:'Main Campus', color:'#66d6a1', accent:'#2b9b72' },
  'bin-02': { name:'Recycle Bin 02', location:'Hostel Zone', color:'#83c9e8', accent:'#3989b5' },
};
