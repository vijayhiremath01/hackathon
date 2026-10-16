import type { AiMessage, AiSource, BinDetails, BinId, BinItemEvent, Scan, ScanInterpretation, ScanInterpretationRecord, ScanResult, Stats } from './types';

const API = (process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `Backend returned ${response.status}`);
  return payload as T;
}
export async function getHealth() { return request<{success:boolean;status:string}>('/api/health'); }
export async function getBin(id: BinId) { return request<{success:boolean;data:BinDetails}>(`/api/bins/${id}`); }
export async function getStats(id: BinId) { return request<{success:boolean;bin_id:BinId;data:Stats}>(`/api/stats?bin_id=${id}`); }
export async function getScans(id: BinId) { return request<{success:boolean;bin_id:BinId;count:number;data:Scan[]}>(`/api/scans?bin_id=${id}&limit=10`); }
export async function uploadScan(id: BinId, image: File) {
  const form = new FormData(); form.append('image', image); form.append('bin_id', id);
  return request<{success:boolean;scan_id:string;bin_id:BinId;data:ScanResult}>('/api/scans', { method:'POST', body:form });
}
export async function createAiConversation(binId: BinId | null) {
  return request<{success:boolean;data:{conversation_id:string;bin_id:BinId|null;created_at:string}}>('/api/ai/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bin_id:binId})});
}
export async function getAiMessages(conversationId:string) {
  return request<{success:boolean;data:{conversation_id:string;bin_id:BinId|null;messages:AiMessage[]}}>(`/api/ai/conversations/${encodeURIComponent(conversationId)}/messages`);
}
export async function sendAiMessage(conversationId:string,binId:BinId|null,message:string) {
  return request<{success:boolean;data:{conversation_id:string;answer:string;bin_id:BinId|null;sources:AiSource[];model:string;prompt_version:string;scope:string}}>('/api/ai/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversation_id:conversationId,bin_id:binId,message})});
}
export async function classifyScan(scanId:string) {
  return request<{success:boolean;cached:boolean;data:ScanInterpretation;acceptance:{results:Array<{event:BinItemEvent;capacity:BinDetails['capacity'];duplicate:boolean}>;capacity:BinDetails['capacity']|null}}>(`/api/ai/scans/${encodeURIComponent(scanId)}/classify`,{method:'POST'});
}
export async function getScanInterpretation(scanId:string) {
  return request<{success:boolean;data:ScanInterpretationRecord}>(`/api/ai/scans/${encodeURIComponent(scanId)}/interpretation`);
}
