/**
 * TypeScript view of the Visual Engine Contract v1 payloads. The JSON Schemas in
 * contracts/visual-engine/schemas are the source of truth; every payload received
 * from an engine is validated against them before these types are trusted.
 */
export const CONTRACT_VERSION = '1.0';

export type Task = 'generate_image' | 'edit_image' | 'upscale_image' | 'generate_video' | 'upscale_video' | 'other';
export type PriorityClass = 'time_sensitive' | 'scheduled_image' | 'video' | 'maintenance';
export type ErrorClass =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'auth'
  | 'resource'
  | 'transient'
  | 'permanent'
  | 'timeout'
  | 'cancelled';
export type EngineJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled';

export const PRIORITY_OF_CLASS: Record<PriorityClass, 2 | 3 | 4 | 5> = {
  time_sensitive: 2,
  scheduled_image: 3,
  video: 4,
  maintenance: 5,
};

export interface WorkflowRef {
  key: string;
  version: string;
}

export interface AssetRef {
  asset_id: string;
  role: string;
  sha256: string;
  mime_type: string;
  bytes?: number;
  width?: number;
  height?: number;
  uri: string;
  expires_at?: string;
}

export interface AdapterRef {
  adapter_id: string;
  kind: 'lora' | 'other';
  engine_ref: string;
  weight?: number;
}

export interface PersonaIdentity {
  influencer_id: string;
  persona_version_id: string;
  persona_version: number;
  identity_package_ref?: string | null;
  visual_traits?: Record<string, unknown>;
  reference_assets?: AssetRef[];
  adapters?: AdapterRef[];
}

export interface ErrorObject {
  code: string;
  class: ErrorClass;
  message: string;
  retryable: boolean;
  retry_after_ms?: number | null;
  details?: Record<string, unknown>;
}

export interface QaResult {
  check: string;
  score?: number | null;
  passed?: boolean | null;
  threshold?: number | null;
  details?: Record<string, unknown>;
}

export interface Provenance {
  engine_id: string;
  engine_version: string;
  workflow_key: string;
  workflow_version: string;
  models?: { role: string; ref: string; sha256?: string; license_ref?: string }[];
  seed?: number | string | null;
  c2pa?: { signed?: boolean; manifest_ref?: string | null };
  engine_metadata?: Record<string, unknown>;
}

export interface Output {
  output_id: string;
  kind: 'image' | 'video';
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'video/webm';
  width?: number;
  height?: number;
  duration_ms?: number | null;
  bytes: number;
  sha256: string;
  download_url?: string;
  file_uri?: string;
  provenance: Provenance;
  qa?: QaResult[];
  metadata?: Record<string, unknown>;
}

export interface ResourceUsage {
  gpu_seconds?: number | null;
  wall_seconds?: number | null;
  vram_peak_mb?: number | null;
}

export interface JobStatus {
  job_id: string;
  request_id: string;
  attempt: number;
  workflow: WorkflowRef;
  state: EngineJobState;
  progress?: { fraction?: number | null; stage?: string | null; message?: string | null } | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  outputs?: Output[];
  error?: ErrorObject | null;
  resource_usage?: ResourceUsage | null;
  engine: { engine_id: string; engine_version: string };
}

export interface JobSubmission {
  contract_version: string;
  request_id: string;
  attempt: number;
  workflow: WorkflowRef;
  influencer_id: string;
  persona: PersonaIdentity;
  parameters: Record<string, unknown>;
  references?: AssetRef[];
  adapters?: AdapterRef[];
  output: { count: number; transfer: 'http_download' | 'file_uri' };
  priority: PriorityClass;
  timeout_s: number;
  deadline_at?: string | null;
  trace?: { trace_id?: string; requested_by?: string };
  callback?: { url?: string; secret_id?: string } | null;
}

export interface EngineInfo {
  engine_id: string;
  engine_version: string;
  engine_kind: 'comfyui' | 'contract_mock' | 'other';
  contract_versions: string[];
  status: 'ready' | 'busy' | 'degraded' | 'maintenance';
  capabilities: {
    max_concurrent_jobs: number;
    cancellation?: boolean;
    progress?: boolean;
    callbacks?: boolean;
    resource_release?: boolean;
    output_transfer: ('http_download' | 'file_uri')[];
  };
  gpu?: { name?: string | null; vram_total_mb?: number | null } | null;
  conformance_mode?: boolean;
}

export interface WorkflowManifest {
  contract_version: string;
  workflow_key: string;
  version: string;
  task: Task;
  title: string;
  description?: string;
  input_schema: Record<string, unknown> & { type: 'object' };
  references?: {
    persona_identity?: { required?: boolean };
    assets?: { roles?: string[]; min?: number; max?: number };
    adapters?: { kinds?: ('lora' | 'other')[]; max?: number };
  };
  outputs: { kind: 'image' | 'video'; mime_types: string[]; count: { min: number; max: number; default?: number } };
  resources: {
    gpu_required: boolean;
    vram_mb_peak?: number | null;
    est_seconds_p50?: number | null;
    est_seconds_p95?: number | null;
    measured_on?: string | null;
    preemptible?: boolean;
    default_priority?: PriorityClass;
  };
  timeouts: { max_runtime_s: number };
  quality?: { qa_checks?: string[] };
  provenance?: { c2pa?: 'engine_signs' | 'platform_signs' | 'none' };
  deprecated?: boolean;
  sunset_at?: string | null;
  engine_metadata?: Record<string, unknown>;
}

export interface WorkflowListEntry {
  workflow_key: string;
  version: string;
  task: Task;
  title?: string;
  deprecated?: boolean;
  manifest_sha256: string;
}

export interface ResourceState {
  status: 'ready' | 'busy' | 'degraded' | 'maintenance';
  vram_total_mb?: number | null;
  vram_in_use_mb?: number | null;
  loaded?: string[];
  running_job_ids: string[];
  queue_depth: number;
}

/** Retry policy by class (contract §8): transient, resource and timeout are retried. */
export function isRetryableClass(cls: ErrorClass | string): boolean {
  return cls === 'transient' || cls === 'resource' || cls === 'timeout';
}
