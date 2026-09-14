export type Scope = 'mc2' | 'masdar-city';

export type Resource =
  | 'scene'
  | 'building'
  | 'floor'
  | 'category'
  | 'metric'
  | 'observation'
  | 'dashboard';

export type Capability =
  | 'content.read'
  | 'content.edit'
  | 'metrics.edit'
  | 'content.publish'
  | 'media.manage'
  | 'users.manage';

export type Vec3 = [number, number, number];

export interface Placement {
  buildingId: string;
  modelUrl: string;
  u: number;
  v: number;
  targetWidth: number;
  rotationDegrees: Vec3;
  verticalOffset: number;
  label: string;
  category: string;
}

export interface SceneData {
  scope: Scope;
  width: number;
  depth: number;
  masterplanUrl: string;
  placements: Placement[];
  camera: {
    target: Vec3;
    radius: number;
    theta: number;
    phi: number;
  };
}

export interface ImageAsset {
  url: string;
  alt: string;
}

export interface BuildingData {
  id: string;
  name: string;
  category: string;
  description: string;
  heightM: number | null;
  floorCount: number;
  gfaM2: number | null;
  availability: string;
  tags: string[];
  images: ImageAsset[];
  enquiryUrl: string | null;
}

export interface FloorData {
  id: string;
  buildingId: string;
  label: string;
  sortOrder: number;
  areaM2: number | null;
  use: string;
  description: string;
  drawing: ImageAsset | null;
  isDefault: boolean;
}

export interface Observation {
  metricKey: string;
  scope: Scope;
  periodStart: string;
  periodEnd: string;
  value: number | null;
  target: number | null;
  source: string;
  isSample: boolean;
}

export type WidgetType =
  | 'kpi'
  | 'line'
  | 'bar'
  | 'composition'
  | 'target'
  | 'image'
  | 'table';

export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  metricKeys: string[];
  order: number;
  image: ImageAsset | null;
}

export interface DashboardData {
  scope: Scope;
  year: number;
  category: string;
  availableScopes: Scope[];
  availableYears: number[];
  categories: string[];
  widgets: Widget[];
  metrics: Array<{
    key: string;
    label: string;
    unit: string;
    precision: number;
    denominator: string | null;
    preferredDirection: 'higher' | 'lower' | 'neutral';
  }>;
  observations: Observation[];
}

export interface Envelope<T> {
  data: T;
  meta: {
    revision: string;
    updatedAt: string;
  };
}

export interface SaveDraft {
  resource: Resource;
  entityId: string;
  expectedRevision: number;
  payload: unknown;
}

export interface PublishRequest {
  entries: Array<{
    resource: Resource;
    entityId: string;
    revision: number;
  }>;
}
