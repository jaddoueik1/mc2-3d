import type {
  BuildingData,
  FloorData,
  ImageAsset,
  Observation,
  Placement,
  Scope,
  Vec3,
  Widget,
  WidgetType,
} from './contracts';

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; errors: string[] };

const scopes = new Set<Scope>(['mc2', 'masdar-city']);
const widgetTypes = new Set<WidgetType>([
  'kpi',
  'line',
  'bar',
  'composition',
  'target',
  'image',
  'table',
]);

function ok<T>(data: T): ValidationResult<T> {
  return { success: true, data };
}

function fail<T>(...errors: string[]): ValidationResult<T> {
  return { success: false, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  errors: string[],
  path: string,
): boolean {
  const actual = Object.keys(value);
  const unexpected = actual.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !(key in value));

  if (unexpected.length > 0) {
    errors.push(`${path} contains unknown field(s): ${unexpected.join(', ')}`);
  }
  if (missing.length > 0) {
    errors.push(`${path} is missing field(s): ${missing.join(', ')}`);
  }
  return unexpected.length === 0 && missing.length === 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requiredString(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${path} must be a non-empty string`);
    return false;
  }
  return true;
}

function stringValue(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== 'string') {
    errors.push(`${path} must be a string`);
    return false;
  }
  return true;
}

function safeUrl(value: unknown, path: string, errors: string[]): value is string {
  if (!requiredString(value, path, errors)) {
    return false;
  }

  if (value.startsWith('/assets/')) {
    return true;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:') {
      return true;
    }
  } catch {
    // The error below explains the accepted URL forms.
  }

  errors.push(`${path} must be an /assets path or an https URL`);
  return false;
}

function nullableNonNegativeNumber(
  value: unknown,
  path: string,
  errors: string[],
): value is number | null {
  if (value === null) {
    return true;
  }
  if (!finiteNumber(value) || value < 0) {
    errors.push(`${path} must be null or a finite number greater than or equal to zero`);
    return false;
  }
  return true;
}

function vec3(value: unknown, path: string, errors: string[]): value is Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(finiteNumber)) {
    errors.push(`${path} must be a three-item array of finite numbers`);
    return false;
  }
  return true;
}

function imageAsset(value: unknown, path: string, errors: string[]): value is ImageAsset {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }

  const shapeIsValid = hasExactKeys(value, ['url', 'alt'], errors, path);
  const urlIsValid = safeUrl(value.url, `${path}.url`, errors);
  const altIsValid = stringValue(value.alt, `${path}.alt`, errors);
  return shapeIsValid && urlIsValid && altIsValid;
}

function isoDate(value: unknown, path: string, errors: string[]): value is string {
  if (!requiredString(value, path, errors)) {
    return false;
  }
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) {
    errors.push(`${path} must be an ISO date (YYYY-MM-DD)`);
    return false;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    errors.push(`${path} must be a valid ISO date`);
    return false;
  }
  return true;
}

export function validatePlacement(value: unknown): ValidationResult<Placement> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return fail('placement must be an object');
  }

  const shapeIsValid = hasExactKeys(
    value,
    [
      'buildingId',
      'modelUrl',
      'u',
      'v',
      'targetWidth',
      'rotationDegrees',
      'verticalOffset',
      'label',
      'category',
    ],
    errors,
    'placement',
  );
  const buildingIdIsValid = requiredString(value.buildingId, 'placement.buildingId', errors);
  const modelUrlIsValid = safeUrl(value.modelUrl, 'placement.modelUrl', errors);
  const uIsValid = finiteNumber(value.u) && value.u >= 0 && value.u <= 1;
  const vIsValid = finiteNumber(value.v) && value.v >= 0 && value.v <= 1;
  const widthIsValid = finiteNumber(value.targetWidth) && value.targetWidth > 0;
  const rotationIsValid = vec3(value.rotationDegrees, 'placement.rotationDegrees', errors);
  const offsetIsValid = finiteNumber(value.verticalOffset);
  const labelIsValid = requiredString(value.label, 'placement.label', errors);
  const categoryIsValid = requiredString(value.category, 'placement.category', errors);

  if (!uIsValid) errors.push('placement.u must be a finite number from 0 to 1');
  if (!vIsValid) errors.push('placement.v must be a finite number from 0 to 1');
  if (!widthIsValid) errors.push('placement.targetWidth must be a finite number greater than zero');
  if (!offsetIsValid) errors.push('placement.verticalOffset must be a finite number');

  return shapeIsValid &&
    buildingIdIsValid &&
    modelUrlIsValid &&
    uIsValid &&
    vIsValid &&
    widthIsValid &&
    rotationIsValid &&
    offsetIsValid &&
    labelIsValid &&
    categoryIsValid
    ? ok(value as Placement)
    : fail(...errors);
}

export function validateBuilding(value: unknown): ValidationResult<BuildingData> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return fail('building must be an object');
  }

  const shapeIsValid = hasExactKeys(
    value,
    [
      'id',
      'name',
      'category',
      'description',
      'heightM',
      'floorCount',
      'gfaM2',
      'availability',
      'tags',
      'images',
      'enquiryUrl',
    ],
    errors,
    'building',
  );
  const idIsValid = requiredString(value.id, 'building.id', errors);
  const nameIsValid = requiredString(value.name, 'building.name', errors);
  const categoryIsValid = requiredString(value.category, 'building.category', errors);
  const descriptionIsValid = stringValue(value.description, 'building.description', errors);
  const heightIsValid = nullableNonNegativeNumber(value.heightM, 'building.heightM', errors);
  const floorCountIsValid =
    finiteNumber(value.floorCount) && Number.isInteger(value.floorCount) && value.floorCount >= 0;
  const gfaIsValid = nullableNonNegativeNumber(value.gfaM2, 'building.gfaM2', errors);
  const availabilityIsValid = stringValue(value.availability, 'building.availability', errors);
  const tagsAreValid =
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string' && tag.trim().length > 0);
  const imagesAreValid =
    Array.isArray(value.images) &&
    value.images.every((image, index) => imageAsset(image, `building.images[${index}]`, errors));

  let enquiryUrlIsValid = value.enquiryUrl === null;
  if (value.enquiryUrl !== null) {
    enquiryUrlIsValid = safeUrl(value.enquiryUrl, 'building.enquiryUrl', errors);
  }

  if (!floorCountIsValid) {
    errors.push('building.floorCount must be an integer greater than or equal to zero');
  }
  if (!tagsAreValid) {
    errors.push('building.tags must be an array of non-empty strings');
  }
  if (!imagesAreValid) {
    errors.push('building.images must be an array of valid image assets');
  }

  return shapeIsValid &&
    idIsValid &&
    nameIsValid &&
    categoryIsValid &&
    descriptionIsValid &&
    heightIsValid &&
    floorCountIsValid &&
    gfaIsValid &&
    availabilityIsValid &&
    tagsAreValid &&
    imagesAreValid &&
    enquiryUrlIsValid
    ? ok(value as BuildingData)
    : fail(...errors);
}

export function validateFloor(value: unknown): ValidationResult<FloorData> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return fail('floor must be an object');
  }

  const shapeIsValid = hasExactKeys(
    value,
    [
      'id',
      'buildingId',
      'label',
      'sortOrder',
      'areaM2',
      'use',
      'description',
      'drawing',
      'isDefault',
    ],
    errors,
    'floor',
  );
  const idIsValid = requiredString(value.id, 'floor.id', errors);
  const buildingIdIsValid = requiredString(value.buildingId, 'floor.buildingId', errors);
  const labelIsValid = requiredString(value.label, 'floor.label', errors);
  const sortOrderIsValid = finiteNumber(value.sortOrder);
  const areaIsValid = nullableNonNegativeNumber(value.areaM2, 'floor.areaM2', errors);
  const useIsValid = stringValue(value.use, 'floor.use', errors);
  const descriptionIsValid = stringValue(value.description, 'floor.description', errors);
  const drawingIsValid =
    value.drawing === null || imageAsset(value.drawing, 'floor.drawing', errors);
  const defaultIsValid = typeof value.isDefault === 'boolean';

  if (!sortOrderIsValid) errors.push('floor.sortOrder must be a finite number');
  if (!defaultIsValid) errors.push('floor.isDefault must be a boolean');

  return shapeIsValid &&
    idIsValid &&
    buildingIdIsValid &&
    labelIsValid &&
    sortOrderIsValid &&
    areaIsValid &&
    useIsValid &&
    descriptionIsValid &&
    drawingIsValid &&
    defaultIsValid
    ? ok(value as FloorData)
    : fail(...errors);
}

export function validateObservation(value: unknown): ValidationResult<Observation> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return fail('observation must be an object');
  }

  const shapeIsValid = hasExactKeys(
    value,
    [
      'metricKey',
      'scope',
      'periodStart',
      'periodEnd',
      'value',
      'target',
      'source',
      'isSample',
    ],
    errors,
    'observation',
  );
  const metricKeyIsValid = requiredString(value.metricKey, 'observation.metricKey', errors);
  const scopeIsValid = typeof value.scope === 'string' && scopes.has(value.scope as Scope);
  const startIsValid = isoDate(value.periodStart, 'observation.periodStart', errors);
  const endIsValid = isoDate(value.periodEnd, 'observation.periodEnd', errors);
  const valueIsValid = value.value === null || finiteNumber(value.value);
  const targetIsValid = value.target === null || finiteNumber(value.target);
  const sourceIsValid = requiredString(value.source, 'observation.source', errors);
  const sampleIsValid = typeof value.isSample === 'boolean';

  if (!scopeIsValid) errors.push('observation.scope must be an allowed scope');
  if (!valueIsValid) errors.push('observation.value must be null or a finite number');
  if (!targetIsValid) errors.push('observation.target must be null or a finite number');
  if (!sampleIsValid) errors.push('observation.isSample must be a boolean');
  if (startIsValid && endIsValid && value.periodEnd < value.periodStart) {
    errors.push('observation.periodEnd must be on or after observation.periodStart');
  }

  return shapeIsValid &&
    metricKeyIsValid &&
    scopeIsValid &&
    startIsValid &&
    endIsValid &&
    valueIsValid &&
    targetIsValid &&
    sourceIsValid &&
    sampleIsValid &&
    !(startIsValid && endIsValid && value.periodEnd < value.periodStart)
    ? ok(value as Observation)
    : fail(...errors);
}

export function validateWidget(value: unknown): ValidationResult<Widget> {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return fail('widget must be an object');
  }

  const shapeIsValid = hasExactKeys(
    value,
    ['id', 'type', 'title', 'metricKeys', 'order', 'image'],
    errors,
    'widget',
  );
  const idIsValid = requiredString(value.id, 'widget.id', errors);
  const typeIsValid = typeof value.type === 'string' && widgetTypes.has(value.type as WidgetType);
  const titleIsValid = requiredString(value.title, 'widget.title', errors);
  const metricKeysAreValid =
    Array.isArray(value.metricKeys) &&
    value.metricKeys.every((metricKey) => typeof metricKey === 'string' && metricKey.trim().length > 0);
  const orderIsValid = finiteNumber(value.order);
  const imageIsValid = value.image === null || imageAsset(value.image, 'widget.image', errors);

  if (!typeIsValid) errors.push('widget.type must be an allowed widget type');
  if (!metricKeysAreValid) errors.push('widget.metricKeys must be an array of non-empty strings');
  if (!orderIsValid) errors.push('widget.order must be a finite number');

  return shapeIsValid &&
    idIsValid &&
    typeIsValid &&
    titleIsValid &&
    metricKeysAreValid &&
    orderIsValid &&
    imageIsValid
    ? ok(value as Widget)
    : fail(...errors);
}
